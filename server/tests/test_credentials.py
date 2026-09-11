import json
import os

import pytest

import server.credentials as credential_module
from server.credentials import CredentialStorageError, DeepSeekCredentialStore


class FakeProtector:
    storage_kind = "test_current_user_encryption"

    def protect(self, value: bytes) -> bytes:
        return bytes(byte ^ 0x5A for byte in value)

    def unprotect(self, value: bytes) -> bytes:
        return bytes(byte ^ 0x5A for byte in value)


def test_credential_store_round_trip_never_writes_plaintext(tmp_path) -> None:
    path = tmp_path / "credentials" / "deepseek.json"
    store = DeepSeekCredentialStore(path=path, protector=FakeProtector())
    secret = "credential-test-do-not-write-plaintext"

    store.save(secret)

    raw = path.read_text(encoding="utf-8")
    payload = json.loads(raw)
    assert secret not in raw
    assert payload["provider"] == "deepseek"
    assert payload["protectedBy"] == "test_current_user_encryption"
    assert store.load() == secret
    assert store.delete() is True
    assert store.load() is None
    assert store.delete() is False


def test_credential_store_rejects_corrupt_or_wrong_scope_payload(tmp_path) -> None:
    path = tmp_path / "deepseek.json"
    path.write_text('{"version":1,"provider":"deepseek","protectedBy":"wrong","ciphertext":"AA=="}', encoding="utf-8")
    store = DeepSeekCredentialStore(path=path, protector=FakeProtector())

    with pytest.raises(CredentialStorageError, match="格式不受支持"):
        store.load()


def test_credential_store_handles_windows_efs_cross_device_replace(monkeypatch, tmp_path) -> None:
    path = tmp_path / "deepseek.json"
    store = DeepSeekCredentialStore(path=path, protector=FakeProtector())
    real_replace = credential_module.os.replace

    def fail_like_windows_efs(source, destination):
        error = OSError("simulated Windows EFS replace failure")
        error.winerror = 17
        raise error

    monkeypatch.setattr(credential_module.os, "replace", fail_like_windows_efs)
    store.save("credential-test-efs-fallback-secret")
    monkeypatch.setattr(credential_module.os, "replace", real_replace)

    assert store.load() == "credential-test-efs-fallback-secret"
    assert not path.with_suffix(".tmp").exists()


@pytest.mark.skipif(os.name != "nt", reason="Windows DPAPI integration test")
def test_windows_dpapi_round_trip_uses_current_user_scope(tmp_path) -> None:
    path = tmp_path / "deepseek.json"
    store = DeepSeekCredentialStore(path=path)
    secret = "credential-dpapi-integration-secret-value"

    store.save(secret)

    assert store.load() == secret
    assert secret not in path.read_text(encoding="utf-8")
