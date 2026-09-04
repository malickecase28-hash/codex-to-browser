from __future__ import annotations

from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one patch site in {path}, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "packages/node/src/backend/client.ts",
    '''  let returnRequested = false;
  let sourceReturned = false;
  const sourceIterator = events[Symbol.asyncIterator]();
  const returnSource = (): void => {
    if (sourceReturned) return;
    sourceReturned = true;
    try {
      const result = sourceIterator.return?.();
      if (result !== undefined) void Promise.resolve(result).catch(() => {});
    } catch {
      // A source iterator's cleanup must not turn caller cancellation into a
      // second observable stream failure.
    }
  };
  const cancel = (): void => {
    if (returnRequested) return;
    returnRequested = true;
    onReturn?.();
    returnSource();
  };
  const queue = new AsyncQueue<ChatGPTRunStreamEvent>(
    DEFAULT_BACKEND_STREAM_QUEUE_LIMIT,
    cancel,
    DEFAULT_BACKEND_STREAM_QUEUE_BYTES_LIMIT
  );
  let resolveCompleted!: (result: ChatGPTRunResult<TOutput>) => void;
  let rejectCompleted!: (error: unknown) => void;
  const completed = new Promise<ChatGPTRunResult<TOutput>>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
''',
    '''  let returnRequested = false;
  let sourceReturned = false;
  const sourceIterator = events[Symbol.asyncIterator]();
  let resolveCompleted!: (result: ChatGPTRunResult<TOutput>) => void;
  let rejectCompleted!: (error: unknown) => void;
  const completed = new Promise<ChatGPTRunResult<TOutput>>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const cancellationError = new BackendClientError(
    "backend_request_cancelled",
    "Backend stream iteration was cancelled locally.",
    true
  );
  const returnSource = (): void => {
    if (sourceReturned) return;
    sourceReturned = true;
    try {
      const result = sourceIterator.return?.();
      if (result !== undefined) void Promise.resolve(result).catch(() => {});
    } catch {
      // A source iterator's cleanup must not turn caller cancellation into a
      // second observable stream failure.
    }
  };
  const cancelTransport = (): void => {
    if (returnRequested) return;
    returnRequested = true;
    try {
      onReturn?.();
    } finally {
      returnSource();
    }
  };
  const cancelByConsumer = (): void => {
    if (returnRequested) return;
    returnRequested = true;
    rejectCompleted(cancellationError);
    try {
      onReturn?.();
    } finally {
      returnSource();
    }
  };
  const queue = new AsyncQueue<ChatGPTRunStreamEvent>(
    DEFAULT_BACKEND_STREAM_QUEUE_LIMIT,
    cancelByConsumer,
    DEFAULT_BACKEND_STREAM_QUEUE_BYTES_LIMIT
  );
''',
)

replace_once(
    "packages/node/src/backend/client.ts",
    '''          if (!queue.push({
            type: "run_item_stream_event",
            name: event.name as ChatGPTRunStreamEvent["name"],
            item: event.item as ChatGPTRunStreamEvent["item"]
          })) {
            cancel();
            throw new BackendClientError(
              "backend_stream_overflow",
              "High-level backend stream buffering exceeded its bounded event queue.",
              true
            );
          }
          continue;
        }
        if (event.type === "completed") {
          resolveCompleted(event.result as ChatGPTRunResult<TOutput>);
''',
    '''          if (!queue.push({
            type: "run_item_stream_event",
            name: event.name as ChatGPTRunStreamEvent["name"],
            item: event.item as ChatGPTRunStreamEvent["item"]
          })) {
            cancelTransport();
            throw new BackendClientError(
              "backend_stream_overflow",
              "High-level backend stream buffering exceeded its bounded event queue.",
              true
            );
          }
          await new Promise<void>(resolve => setImmediate(resolve));
          if (returnRequested) throw cancellationError;
          continue;
        }
        if (event.type === "completed") {
          if (returnRequested) throw cancellationError;
          resolveCompleted(event.result as ChatGPTRunResult<TOutput>);
''',
)

replace_once(
    "packages/python/src/codex_chatgpt_control/operation_models.py",
    '''class NewTarget(StrictWireModel):
    type: Literal["new"]
''',
    '''class NewTarget(StrictWireModel):
    type: Literal["new"]
    url: BoundedText4096 | None = None

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        _bounded_utf8(value, max_bytes=4096, field_name="target URL")
        try:
            parsed = urlsplit(value)
        except ValueError as exc:
            raise ValueError("target URL must be a bounded HTTP(S) URL") from exc
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)
        ):
            raise ValueError("target URL must be an HTTP(S) URL without control characters")
        return value
''',
)

replace_once(
    "packages/python/src/codex_chatgpt_control/runner.py",
    '''    if _is_one_of(target_type, "new"):
        allowed = {"type"}
        if _first_unknown_key(target, allowed) is not None:
            raise TransactionalInputError("target", "new targets cannot contain additional fields.")
        return {"type": "new"}
''',
    '''    if _is_one_of(target_type, "new"):
        allowed = {"type", "url"}
        if _first_unknown_key(target, allowed) is not None:
            raise TransactionalInputError("target", "new targets contain an unsupported field.")
        url = _wire_key(target, "url")
        if url is None:
            return {"type": "new"}
        if not isinstance(url, str) or not url:
            raise TransactionalInputError("target.url", "url must be non-empty when supplied for a new target.")
        return {"type": "new", "url": url}
''',
)

Path("packages/python/tests/test_project_new_target.py").write_text(
    '''from __future__ import annotations

import unittest

from codex_chatgpt_control.operation_models import NewTarget
from codex_chatgpt_control.runner import TransactionalInputError, _direct_target


class ProjectScopedNewTargetTests(unittest.TestCase):
    def test_typed_new_target_preserves_project_start_url(self) -> None:
        url = "https://chatgpt.com/g/g-p-project-123/project"
        target = NewTarget(type="new", url=url)
        self.assertEqual(target.to_wire(), {"type": "new", "url": url})

    def test_typed_new_target_rejects_non_http_url(self) -> None:
        with self.assertRaises(ValueError):
            NewTarget(type="new", url="file:///tmp/not-a-project")

    def test_direct_target_preserves_optional_start_url(self) -> None:
        url = "https://chatgpt.com/g/g-p-project-123/project"
        self.assertEqual(_direct_target({"type": "new", "url": url}), {"type": "new", "url": url})
        self.assertEqual(_direct_target({"type": "new"}), {"type": "new"})

    def test_direct_target_still_rejects_unknown_fields(self) -> None:
        with self.assertRaises(TransactionalInputError):
            _direct_target({"type": "new", "url": "https://chatgpt.com/", "title": "unsafe"})


if __name__ == "__main__":
    unittest.main()
''',
    encoding="utf-8",
)
