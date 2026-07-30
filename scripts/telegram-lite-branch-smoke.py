import json
import os
import time
import urllib.parse
import urllib.request


CHAT_ID = 524019827
BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
WEBHOOK_SECRET = os.environ["TELEGRAM_WEBHOOK_SECRET"]
API = f"https://api.telegram.org/bot{BOT_TOKEN}"
WORKER = "https://camelai-telegram-172a28c1.ouihfugxhcqe.workers.dev/telegram/webhook"
created_message_ids: set[int] = set()


def telegram(method: str, data: dict[str, object]) -> dict[str, object]:
    request = urllib.request.Request(
        f"{API}/{method}",
        data=urllib.parse.urlencode(data).encode(),
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def send_seed(label: str) -> int:
    payload = telegram("sendMessage", {"chat_id": CHAT_ID, "text": label})
    message_id = int(payload["result"]["message_id"])
    created_message_ids.add(message_id)
    return message_id


def post_update(message_id: int, text: str, reply_to_message_id: int | None = None) -> None:
    message: dict[str, object] = {
        "message_id": message_id,
        "chat": {"id": CHAT_ID},
        "from": {"id": CHAT_ID, "first_name": "Branch Smoke"},
        "text": text,
    }
    if reply_to_message_id is not None:
        message["reply_to_message"] = {"message_id": reply_to_message_id}
    request = urllib.request.Request(
        WORKER,
        data=json.dumps({"update_id": time.time_ns(), "message": message}).encode(),
        headers={
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f"Webhook returned HTTP {response.status}")


def find_bot_text(after_message_id: int, expected: str, wait_seconds: int = 45) -> int:
    time.sleep(wait_seconds)
    for candidate in range(after_message_id + 1, after_message_id + 14):
        try:
            payload = telegram(
                "forwardMessage",
                {
                    "chat_id": CHAT_ID,
                    "from_chat_id": CHAT_ID,
                    "message_id": candidate,
                },
            )
        except Exception:
            continue
        forwarded = payload.get("result") or {}
        forwarded_id = forwarded.get("message_id")
        if isinstance(forwarded_id, int):
            telegram("deleteMessage", {"chat_id": CHAT_ID, "message_id": forwarded_id})
        sender = forwarded.get("from") or {}
        if sender.get("is_bot") is not True:
            continue
        created_message_ids.add(candidate)
        text = str(forwarded.get("text") or "").strip()
        print(json.dumps({"candidate": candidate, "text": text}, ensure_ascii=False))
        if text == expected:
            return candidate
    raise RuntimeError(f"Timed out waiting for bot text {expected!r}")


def cleanup() -> None:
    for message_id in sorted(created_message_ids, reverse=True):
        try:
            telegram("deleteMessage", {"chat_id": CHAT_ID, "message_id": message_id})
        except Exception:
            pass


try:
    root_seed = send_seed("camelAI branch smoke root")
    post_update(
        root_seed,
        "Branch test: the only codeword introduced so far is ALPHA. Reply exactly BRANCH-A.",
    )
    root_final = find_bot_text(root_seed, "BRANCH-A")

    later_seed = send_seed("camelAI branch smoke later turn")
    post_update(
        later_seed,
        "Introduce a new codeword BETA. Reply exactly BRANCH-B.",
        root_final,
    )
    find_bot_text(later_seed, "BRANCH-B")

    fork_seed = send_seed("camelAI branch smoke fork")
    post_update(
        fork_seed,
        "Inspect only the conversation context before this message. If it contains ALPHA and does not contain BETA, reply exactly BRANCH-OK. Otherwise reply exactly BRANCH-LEAK.",
        root_final,
    )
    find_bot_text(fork_seed, "BRANCH-OK")
    print("Telegram branch smoke passed: replying to an older final excluded later turns")
finally:
    cleanup()
