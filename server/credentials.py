from __future__ import annotations

import base64
import ctypes
import json
import os
import shutil
from pathlib import Path
from typing import Optional, Protocol


_CREDENTIAL_VERSION = 1
_PROVIDER = "deepseek"
_ENTROPY = b"xirang.deepseek.credential.v1"
_STORAGE_KIND = "windows_dpapi_current_user"


class CredentialStorageError(RuntimeError):
    pass


class CredentialProtector(Protocol):
    storage_kind: str

    def protect(self, value: bytes) -> bytes: ...

    def unprotect(self, value: bytes) -> bytes: ...


class _DataBlob(ctypes.Structure):
    _fields_ = [
        ("cbData", ctypes.c_ulong),
        ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
    ]


def _data_blob(value: bytes) -> tuple[_DataBlob, ctypes.Array]:
    buffer = ctypes.create_string_buffer(value)
    blob = _DataBlob(
        len(value),
        ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)),
    )
    return blob, buffer


class WindowsDpapiProtector:
    """Protect secrets for the current Windows user without third-party packages."""

    storage_kind = _STORAGE_KIND
    _CRYPTPROTECT_UI_FORBIDDEN = 0x1

    def __init__(self) -> None:
        if os.name != "nt":
            raise CredentialStorageError("安全持久化目前仅支持 Windows 当前用户。")
        try:
            self._crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
            self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        except OSError as error:
            raise CredentialStorageError("无法加载 Windows 凭据加密组件。") from error

        self._crypt32.CryptProtectData.argtypes = [
            ctypes.POINTER(_DataBlob),
            ctypes.c_wchar_p,
            ctypes.POINTER(_DataBlob),
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.POINTER(_DataBlob),
        ]
        self._crypt32.CryptProtectData.restype = ctypes.c_int
        self._crypt32.CryptUnprotectData.argtypes = [
            ctypes.POINTER(_DataBlob),
            ctypes.c_void_p,
            ctypes.POINTER(_DataBlob),
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.POINTER(_DataBlob),
        ]
        self._crypt32.CryptUnprotectData.restype = ctypes.c_int
        self._kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        self._kernel32.LocalFree.restype = ctypes.c_void_p

    def protect(self, value: bytes) -> bytes:
        if not value:
            raise CredentialStorageError("不能保存空凭据。")
        source, source_buffer = _data_blob(value)
        entropy, entropy_buffer = _data_blob(_ENTROPY)
        protected = _DataBlob()
        succeeded = self._crypt32.CryptProtectData(
            ctypes.byref(source),
            "Xirang DeepSeek API credential",
            ctypes.byref(entropy),
            None,
            None,
            self._CRYPTPROTECT_UI_FORBIDDEN,
            ctypes.byref(protected),
        )
        if not succeeded:
            raise CredentialStorageError("Windows 无法加密 DeepSeek 凭据。") from ctypes.WinError(ctypes.get_last_error())
        try:
            return ctypes.string_at(protected.pbData, protected.cbData)
        finally:
            self._kernel32.LocalFree(protected.pbData)

    def unprotect(self, value: bytes) -> bytes:
        if not value:
            raise CredentialStorageError("本机凭据文件内容为空。")
        source, source_buffer = _data_blob(value)
        entropy, entropy_buffer = _data_blob(_ENTROPY)
        unprotected = _DataBlob()
        succeeded = self._crypt32.CryptUnprotectData(
            ctypes.byref(source),
            None,
            ctypes.byref(entropy),
            None,
            None,
            self._CRYPTPROTECT_UI_FORBIDDEN,
            ctypes.byref(unprotected),
        )
        if not succeeded:
            raise CredentialStorageError("Windows 无法解密 DeepSeek 凭据；它可能属于其他用户或设备。") from ctypes.WinError(ctypes.get_last_error())
        try:
            return ctypes.string_at(unprotected.pbData, unprotected.cbData)
        finally:
            self._kernel32.LocalFree(unprotected.pbData)


def default_credential_path() -> Path:
    override = os.environ.get("XIRANG_CREDENTIAL_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve() / "deepseek.json"
    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    if local_app_data:
        return Path(local_app_data) / "Xirang" / "credentials" / "deepseek.json"
    return Path.home() / ".xirang" / "credentials" / "deepseek.json"


class DeepSeekCredentialStore:
    def __init__(
        self,
        path: Optional[Path] = None,
        protector: Optional[CredentialProtector] = None,
    ) -> None:
        self.path = path or default_credential_path()
        self._protector = protector

    @property
    def supported(self) -> bool:
        return self._protector is not None or os.name == "nt"

    @property
    def storage_kind(self) -> str:
        if self._protector is not None:
            return self._protector.storage_kind
        return _STORAGE_KIND

    def _active_protector(self) -> CredentialProtector:
        if self._protector is None:
            self._protector = WindowsDpapiProtector()
        return self._protector

    def exists(self) -> bool:
        return self.path.is_file()

    def save(self, api_key: str) -> None:
        normalized = api_key.strip()
        if not normalized:
            raise CredentialStorageError("DeepSeek API Key 不能为空。")
        try:
            protected = self._active_protector().protect(normalized.encode("utf-8"))
            payload = {
                "version": _CREDENTIAL_VERSION,
                "provider": _PROVIDER,
                "protectedBy": self.storage_kind,
                "ciphertext": base64.b64encode(protected).decode("ascii"),
            }
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(payload, ensure_ascii=True), encoding="utf-8")
            try:
                os.replace(temporary, self.path)
            except OSError as error:
                # Windows EFS-encrypted directories can report ERROR_NOT_SAME_DEVICE
                # for an otherwise same-directory replace. Copy the already-DPAPI-
                # protected payload and remove the temporary file in that one case.
                if getattr(error, "winerror", None) != 17:
                    raise
                shutil.copyfile(temporary, self.path)
                temporary.unlink()
        except CredentialStorageError:
            raise
        except (OSError, ValueError) as error:
            raise CredentialStorageError("无法保存本机加密凭据。") from error

    def load(self) -> Optional[str]:
        if not self.exists():
            return None
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if (
                not isinstance(payload, dict)
                or payload.get("version") != _CREDENTIAL_VERSION
                or payload.get("provider") != _PROVIDER
                or payload.get("protectedBy") != self.storage_kind
                or not isinstance(payload.get("ciphertext"), str)
            ):
                raise CredentialStorageError("本机凭据文件格式不受支持。")
            protected = base64.b64decode(payload["ciphertext"], validate=True)
            api_key = self._active_protector().unprotect(protected).decode("utf-8").strip()
            if not api_key:
                raise CredentialStorageError("本机凭据解密后为空。")
            return api_key
        except CredentialStorageError:
            raise
        except (OSError, ValueError, UnicodeError, json.JSONDecodeError) as error:
            raise CredentialStorageError("无法读取本机加密凭据。") from error

    def delete(self) -> bool:
        try:
            if not self.exists():
                return False
            self.path.unlink()
            return True
        except OSError as error:
            raise CredentialStorageError("无法删除本机加密凭据。") from error


deepseek_credential_store = DeepSeekCredentialStore()
