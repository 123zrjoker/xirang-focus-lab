from __future__ import annotations

import argparse
import json
from pathlib import Path

from ...agent.harness import AgentHarness
from ...agent.planner import DeepSeekActionPlanner
from ...agent.prompts import build_prompt_registry
from ...generation import DeepSeekChatProvider
from .dataset import DEFAULT_FAKE_DATASET, DEFAULT_REAL_DATASET
from .reporting import markdown_report


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FAKE_REPORT = ROOT / "artifacts" / "evals" / "0.5.2-agent-fake-eval.md"
DEFAULT_FAKE_JSON = ROOT / "artifacts" / "evals" / "0.5.2-agent-fake-eval.json"
DEFAULT_REAL_REPORT = ROOT / "artifacts" / "evals" / "0.5.2-agent-deepseek-holdout.md"
DEFAULT_REAL_JSON = ROOT / "artifacts" / "evals" / "0.5.2-agent-deepseek-holdout.json"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="运行息壤 Agent 轨迹与安全评测。")
    parser.add_argument("--real", action="store_true", help="运行会产生 API 费用的 DeepSeek 小型保留集。")
    parser.add_argument(
        "--allow-paid-api",
        action="store_true",
        help="显式确认允许真实模型调用；没有此参数时 --real 会拒绝执行。",
    )
    parser.add_argument("--dataset", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--json", dest="json_path", type=Path)
    parser.add_argument("--no-fail-on-gate", action="store_true")
    return parser


def main() -> None:
    args = _parser().parse_args()
    if args.real and not args.allow_paid_api:
        raise SystemExit("真实评测会调用付费 API；请显式添加 --allow-paid-api。")

    prompts = build_prompt_registry()
    if args.real:
        provider = DeepSeekChatProvider()
        if not provider.available:
            raise SystemExit("DeepSeek 未配置；请先保存凭据或设置 DEEPSEEK_API_KEY。")
        harness = AgentHarness(
            planner=DeepSeekActionPlanner(provider, prompts.get("weekly_planner").content),
            prompts=prompts,
        )
        dataset_path = args.dataset or DEFAULT_REAL_DATASET
        report_path = args.report or DEFAULT_REAL_REPORT
        json_path = args.json_path or DEFAULT_REAL_JSON
    else:
        harness = AgentHarness(prompts=prompts)
        dataset_path = args.dataset or DEFAULT_FAKE_DATASET
        report_path = args.report or DEFAULT_FAKE_REPORT
        json_path = args.json_path or DEFAULT_FAKE_JSON

    evaluation = harness.evaluate(dataset_path)
    json_text = json.dumps(evaluation.model_dump(mode="json", by_alias=True), ensure_ascii=False, indent=2)
    markdown_text = markdown_report(evaluation)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(markdown_text, encoding="utf-8")
    json_path.write_text(json_text, encoding="utf-8")
    print(json.dumps({
        "report": str(report_path),
        "json": str(json_path),
        "metrics": evaluation.metrics,
        "gate": evaluation.gate,
    }, ensure_ascii=False, indent=2))
    if not evaluation.gate["passed"] and not args.no_fail_on_gate:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
