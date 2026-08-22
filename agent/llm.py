"""LLM tool loop. Same tools for OpenAI and Anthropic.

Default model is Claude Sonnet 5: this product's failure mode is unsourced
claims, and Claude is the better instruction-follower for that. OpenAI gpt-4.1
is the other option (--provider openai). Temperature 0. Does not command the
spacecraft.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from agent.tools import Tools, public_event, public_row

ROOT = Path(__file__).resolve().parent.parent
MAX_TURNS = 12

DEFAULT_MODELS = {
    "anthropic": "claude-sonnet-5",
    "openai": "gpt-4.1",
}

SYSTEM = """You are ORBIT, an investigation assistant for spacecraft operations.

You start AFTER an anomaly is already detected. You do not detect anomalies.
You do not command the spacecraft. You assemble evidence and stop at a
recommended human decision.

Rules:
- Numbers come only from tool results. If a tool did not return it, do not state it.
- Tag every claim: [OBSERVED] telemetry/commands, [DERIVED] ratios and limit checks,
  [DOCUMENTED] procedures/incidents, [HYPOTHESIS] root cause and recommended action.
- Follow procedure EPS-17: confirm the voltage warn, list commands in the prior
  10 minutes, read each load that just turned on, compare to healthy range,
  do not close on a coincidental SCIENCE_MODE without checking heater current,
  search for a similar incident.
- A payload mode change in the same window is a confounder, not automatic proof.
- If no load meets the procedure's ≥2× threshold, omit ## Hypothesis. Write
  ## What is ruled out and ## What would change this. Do not recommend inhibit
  or safe actions — recommend Hold (do not command).
- Otherwise end with a hypothesis and a recommended human decision that is NOT executed.
- Be precise and deterministic. Do not add color that is not in the tools.

Write a markdown investigation report. No preamble before the heading.
"""

TOOL_PARAMS = [
    {
        "name": "first_warn",
        "description": "First sample where a channel crosses its warn limit.",
        "parameters": {
            "type": "object",
            "properties": {
                "run_id": {"type": "string"},
                "channel": {"type": "string"},
            },
            "required": ["run_id", "channel"],
        },
    },
    {
        "name": "events_before",
        "description": "Commands and mode changes in the window ending at deadline_clock.",
        "parameters": {
            "type": "object",
            "properties": {
                "run_id": {"type": "string"},
                "deadline_clock": {"type": "string", "description": "HH:MM:SS"},
                "window_s": {"type": "number", "description": "Seconds before deadline. Default 600."},
            },
            "required": ["run_id", "deadline_clock"],
        },
    },
    {
        "name": "sample",
        "description": "Channel value nearest to clock (HH:MM:SS).",
        "parameters": {
            "type": "object",
            "properties": {
                "run_id": {"type": "string"},
                "channel": {"type": "string"},
                "clock": {"type": "string"},
            },
            "required": ["run_id", "channel", "clock"],
        },
    },
    {
        "name": "channel_meta",
        "description": "Spec limits and units for a channel.",
        "parameters": {
            "type": "object",
            "properties": {"channel": {"type": "string"}},
            "required": ["channel"],
        },
    },
    {
        "name": "search_docs",
        "description": "Semantic search over procedures and incidents. Returns id, kind, title, score.",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
    {
        "name": "get_doc",
        "description": "Fetch a procedure or incident by id (EPS-17, INC-0187).",
        "parameters": {
            "type": "object",
            "properties": {"doc_id": {"type": "string"}},
            "required": ["doc_id"],
        },
    },
]


def load_dotenv() -> None:
    from agent.tracing import load_env_files

    load_env_files()


def resolve_provider(requested: str) -> str:
    load_dotenv()
    if requested == "auto":
        requested = os.environ.get("ORBIT_LLM", "auto")
    if requested == "openai":
        if not os.environ.get("OPENAI_API_KEY"):
            raise SystemExit("missing OPENAI_API_KEY in environment or .env")
        return "openai"
    if requested == "anthropic":
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise SystemExit("missing ANTHROPIC_API_KEY in environment or .env")
        return "anthropic"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    raise SystemExit(
        "No API key found. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env "
        "(see .env.example), or pass --provider rules for the non-LLM path."
    )


def openai_tools() -> list[dict[str, Any]]:
    return [
        {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["parameters"]}}
        for t in TOOL_PARAMS
    ]


def anthropic_tools() -> list[dict[str, Any]]:
    return [
        {"name": t["name"], "description": t["description"], "input_schema": t["parameters"]}
        for t in TOOL_PARAMS
    ]


def dispatch(tools: Tools, name: str, args: dict[str, Any]) -> Any:
    if name == "first_warn":
        return public_row(tools.first_warn(args["run_id"], args["channel"]))
    if name == "events_before":
        rows = tools.events_before_clock(
            args["run_id"], args["deadline_clock"], float(args.get("window_s") or 600)
        )
        return [public_event(row) for row in rows]
    if name == "sample":
        return public_row(tools.sample_at_clock(args["run_id"], args["channel"], args["clock"]))
    if name == "channel_meta":
        return tools.channel_meta(args["channel"])
    if name == "search_docs":
        return tools.search_docs(args["query"])
    if name == "get_doc":
        row = tools.get_doc(args["doc_id"])
        if row is None:
            return None
        return {"id": row["id"], "kind": row["kind"], "title": row["title"], "body": row["body"]}
    return {"error": f"unknown tool {name}"}


def investigate_llm(
    tools: Tools,
    run_id: str,
    alarm_channel: str,
    provider: str,
    model: str | None = None,
) -> str:
    from agent.tracing import init_tracing

    load_dotenv()
    init_tracing()
    model = model or os.environ.get("ORBIT_MODEL") or DEFAULT_MODELS[provider]
    user = (
        f"Investigate run `{run_id}`. Entry: `{alarm_channel}` warn. "
        "Use tools. Follow EPS-17. Write the tagged markdown report."
    )
    if provider == "anthropic":
        text = _anthropic_loop(tools, user, model)
    else:
        text = _openai_loop(tools, user, model)
    appendix = "\n".join(
        [
            "",
            "## Tool log",
            "",
            *[f"- {item}" for item in tools.log],
            "",
            f"_Provider: {provider}  Model: {model}_",
            "",
        ]
    )
    return text.rstrip() + "\n" + appendix


def _openai_loop(tools: Tools, user: str, model: str) -> str:
    from openai import OpenAI

    try:
        from braintrust import wrap_openai

        client = wrap_openai(OpenAI())
    except Exception:
        client = OpenAI()
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": user},
    ]
    for _ in range(MAX_TURNS):
        resp = client.chat.completions.create(
            model=model,
            temperature=0,
            messages=messages,
            tools=openai_tools(),
        )
        msg = resp.choices[0].message
        if not msg.tool_calls:
            return msg.content or ""
        messages.append(msg)
        for call in msg.tool_calls:
            args = json.loads(call.function.arguments or "{}")
            result = dispatch(tools, call.function.name, args)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps(result, default=str),
                }
            )
    raise RuntimeError("LLM hit max tool turns without a final report")


def _anthropic_loop(tools: Tools, user: str, model: str) -> str:
    import anthropic

    try:
        from braintrust import wrap_anthropic

        client = wrap_anthropic(anthropic.Anthropic())
    except Exception:
        client = anthropic.Anthropic()
    messages: list[dict[str, Any]] = [{"role": "user", "content": user}]
    for _ in range(MAX_TURNS):
        resp = client.messages.create(
            model=model,
            max_tokens=4000,
            system=SYSTEM,
            tools=anthropic_tools(),
            messages=messages,
        )
        if resp.stop_reason == "end_turn":
            return "".join(block.text for block in resp.content if block.type == "text")
        tool_results = []
        for block in resp.content:
            if block.type != "tool_use":
                continue
            result = dispatch(tools, block.name, dict(block.input))
            tool_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(result, default=str),
                }
            )
        messages.append({"role": "assistant", "content": resp.content})
        messages.append({"role": "user", "content": tool_results})
    raise RuntimeError("LLM hit max tool turns without a final report")
