from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from .commands import request_backend
from .models import CommandResult


SyncRequester = Callable[[str, dict[str, Any]], Any]
AsyncRequester = Callable[[str, dict[str, Any]], Awaitable[Any]]

DEV_BACKEND_COMMANDS = {"dispatch": "dev.dispatch"}


def _payload(namespace: str, action: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "namespace": namespace,
        "action": action,
        "args": args or {},
    }


def _command_result(value: Any) -> CommandResult:
    if not isinstance(value, dict):
        raise RuntimeError("dev.dispatch result must be a CommandResult object.")
    return CommandResult.from_wire(value)


def _record(value: Any, *, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} result must be a JSON object.")
    return value


class _SyncDevNamespace:
    def __init__(self, request: SyncRequester, namespace: str) -> None:
        self._request = request
        self._namespace = namespace

    def command(self, action: str, **args: Any) -> CommandResult:
        return _command_result(self._request(DEV_BACKEND_COMMANDS["dispatch"], _payload(self._namespace, action, args)))

    def raw(self, action: str, **args: Any) -> Any:
        return self._request(DEV_BACKEND_COMMANDS["dispatch"], _payload(self._namespace, action, args))


class DevProjectChatsClient:
    def __init__(self, namespace: _SyncDevNamespace) -> None:
        self._namespace = namespace

    def list(self, ref: Any) -> CommandResult:
        return self._namespace.command("chats.list", ref=ref)

    def open(self, ref: Any, chat_ref: str) -> CommandResult:
        return self._namespace.command("chats.open", ref=ref, chatRef=chat_ref)


class DevProjectContextClient:
    def __init__(self, namespace: _SyncDevNamespace) -> None:
        self._namespace = namespace

    def inspect(self, ref: Any) -> CommandResult:
        return self._namespace.command("context.inspect", ref=ref)


class DevProjectsClient:
    def __init__(self, request: SyncRequester) -> None:
        self._namespace = _SyncDevNamespace(request, "projects")
        self.chats = DevProjectChatsClient(self._namespace)
        self.context = DevProjectContextClient(self._namespace)

    def list(self, *, filters: dict[str, Any] | None = None) -> CommandResult:
        return self._namespace.command("list", **({} if filters is None else {"filters": filters}))

    def get(self, ref: Any) -> CommandResult:
        return self._namespace.command("get", ref=ref)

    def find(self, query: str) -> CommandResult:
        return self._namespace.command("find", query=query)

    def open(self, ref: Any) -> CommandResult:
        return self._namespace.command("open", ref=ref)

    def ensure(self, spec: dict[str, Any]) -> CommandResult:
        return self._namespace.command("ensure", spec=spec)

    def create(self, spec: dict[str, Any]) -> CommandResult:
        return self._namespace.command("create", spec=spec)

    def update(self, ref: Any, changes: dict[str, Any]) -> CommandResult:
        return self._namespace.command("update", ref=ref, changes=changes)

    def delete(
        self,
        ref: Any,
        *,
        idempotency_key: str | None = None,
        confirm_mutation: bool = False,
    ) -> CommandResult:
        options = {
            **({} if idempotency_key is None else {"idempotencyKey": idempotency_key}),
            "confirmMutation": confirm_mutation,
        }
        return self._namespace.command("delete", ref=ref, options=options)


class DevPlannerClient:
    def __init__(self, request: SyncRequester) -> None:
        self._namespace = _SyncDevNamespace(request, "planner")

    def inspect(self) -> CommandResult:
        return self._namespace.command("inspect")

    def list(self) -> CommandResult:
        return self._namespace.command("list")

    def get(self, ref: Any) -> CommandResult:
        return self._namespace.command("get", ref=ref)

    def find(self, query: str) -> CommandResult:
        return self._namespace.command("find", query=query)

    def create(self, spec: dict[str, Any]) -> CommandResult:
        return self._namespace.command("create", spec=spec)

    def update(self, ref: Any, changes: dict[str, Any]) -> CommandResult:
        return self._namespace.command("update", ref=ref, changes=changes)

    def delete(
        self,
        ref: Any,
        *,
        idempotency_key: str | None = None,
        confirm_mutation: bool = False,
    ) -> CommandResult:
        options = {
            **({} if idempotency_key is None else {"idempotencyKey": idempotency_key}),
            "confirmMutation": confirm_mutation,
        }
        return self._namespace.command("delete", ref=ref, options=options)

    def set_enabled(self, ref: Any, enabled: bool, *, idempotency_key: str | None = None) -> CommandResult:
        options = {} if idempotency_key is None else {"idempotencyKey": idempotency_key}
        return self._namespace.command("setEnabled", ref=ref, enabled=enabled, options=options)

    def runs(self, ref: Any) -> CommandResult:
        return self._namespace.command("runs", ref=ref)

    def run_now(self, ref: Any, *, idempotency_key: str | None = None) -> CommandResult:
        options = {} if idempotency_key is None else {"idempotencyKey": idempotency_key}
        return self._namespace.command("runNow", ref=ref, options=options)


class DevWorkerClient:
    def __init__(self, request: SyncRequester) -> None:
        self._namespace = _SyncDevNamespace(request, "worker")

    def start(self, spec: dict[str, Any]) -> CommandResult:
        return self._namespace.command("start", spec=spec)

    def stop(self, ref: Any) -> CommandResult:
        return self._namespace.command("stop", ref=ref)

    def status(self, ref: Any) -> CommandResult:
        return self._namespace.command("status", ref=ref)

    def list(self) -> CommandResult:
        return self._namespace.command("list")


class DevAutonomousClient:
    def __init__(self, request: SyncRequester) -> None:
        self._namespace = _SyncDevNamespace(request, "autonomous")

    def plan(self, spec: dict[str, Any], *, options: dict[str, Any] | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {"spec": spec}
        if options is not None:
            args["options"] = options
        return _record(self._namespace.raw("plan", **args), label="autonomous.plan")

    def bootstrap(self, spec: dict[str, Any], *, options: dict[str, Any] | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {"spec": spec}
        if options is not None:
            args["options"] = options
        return _record(self._namespace.raw("bootstrap", **args), label="autonomous.bootstrap")

    def create(self, plan: dict[str, Any]) -> dict[str, Any]:
        return _record(self._namespace.raw("create", plan=plan), label="autonomous.create")

    def get(self, workflow_id: str) -> dict[str, Any]:
        return _record(self._namespace.raw("get", workflowId=workflow_id), label="autonomous.get")

    def advance(self, workflow_id: str, *, options: dict[str, Any] | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {"workflowId": workflow_id}
        if options is not None:
            args["options"] = options
        return _record(self._namespace.raw("advance", **args), label="autonomous.advance")

    def run(self, workflow_id: str, *, options: dict[str, Any] | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {"workflowId": workflow_id}
        if options is not None:
            args["options"] = options
        return _record(self._namespace.raw("run", **args), label="autonomous.run")

    def resume_task(self, workflow_id: str, task_id: str) -> dict[str, Any]:
        return _record(
            self._namespace.raw("resumeTask", workflowId=workflow_id, taskId=task_id),
            label="autonomous.resumeTask",
        )


class DevClient:
    def __init__(self, backend: Any) -> None:
        request = getattr(backend, "request", None)
        if callable(request):
            requester: SyncRequester = request
        else:
            requester = lambda command, payload: request_backend(backend, command, payload)
        self.projects = DevProjectsClient(requester)
        self.planner = DevPlannerClient(requester)
        self.worker = DevWorkerClient(requester)
        self.autonomous = DevAutonomousClient(requester)


class _AsyncDevNamespace:
    def __init__(self, request: AsyncRequester, namespace: str) -> None:
        self._request = request
        self._namespace = namespace

    async def command(self, action: str, **args: Any) -> CommandResult:
        return _command_result(await self._request(DEV_BACKEND_COMMANDS["dispatch"], _payload(self._namespace, action, args)))

    async def raw(self, action: str, **args: Any) -> Any:
        return await self._request(DEV_BACKEND_COMMANDS["dispatch"], _payload(self._namespace, action, args))


class AsyncDevProjectChatsClient:
    def __init__(self, namespace: _AsyncDevNamespace) -> None:
        self._namespace = namespace

    async def list(self, ref: Any) -> CommandResult:
        return await self._namespace.command("chats.list", ref=ref)

    async def open(self, ref: Any, chat_ref: str) -> CommandResult:
        return await self._namespace.command("chats.open", ref=ref, chatRef=chat_ref)


class AsyncDevProjectContextClient:
    def __init__(self, namespace: _AsyncDevNamespace) -> None:
        self._namespace = namespace

    async def inspect(self, ref: Any) -> CommandResult:
        return await self._namespace.command("context.inspect", ref=ref)


class AsyncDevProjectsClient:
    def __init__(self, request: AsyncRequester) -> None:
        self._namespace = _AsyncDevNamespace(request, "projects")
        self.chats = AsyncDevProjectChatsClient(self._namespace)
        self.context = AsyncDevProjectContextClient(self._namespace)

    async def list(self, *, filters: dict[str, Any] | None = None) -> CommandResult:
        return await self._namespace.command("list", **({} if filters is None else {"filters": filters}))

    async def get(self, ref: Any) -> CommandResult:
        return await self._namespace.command("get", ref=ref)

    async def find(self, query: str) -> CommandResult:
        return await self._namespace.command("find", query=query)

    async def open(self, ref: Any) -> CommandResult:
        return await self._namespace.command("open", ref=ref)

    async def ensure(self, spec: dict[str, Any]) -> CommandResult:
        return await self._namespace.command("ensure", spec=spec)

    async def create(self, spec: dict[str, Any]) -> CommandResult:
        return await self._namespace.command("create", spec=spec)

    async def update(self, ref: Any, changes: dict[str, Any]) -> CommandResult:
        return await self._namespace.command("update", ref=ref, changes=changes)

    async def delete(
        self,
        ref: Any,
        *,
        idempotency_key: str | None = None,
        confirm_mutation: bool = False,
    ) -> CommandResult:
        options = {
            **({} if idempotency_key is None else {"idempotencyKey": idempotency_key}),
            "confirmMutation": confirm_mutation,
        }
        return await self._namespace.command("delete", ref=ref, options=options)


class AsyncDevPlannerClient:
    def __init__(self, request: AsyncRequester) -> None:
        self._namespace = _AsyncDevNamespace(request, "planner")

    async def inspect(self) -> CommandResult:
        return await self._namespace.command("inspect")

    async def list(self) -> CommandResult:
        return await self._namespace.command("list")

    async def get(self, ref: Any) -> CommandResult:
        return await self._namespace.command("get", ref=ref)

    async def find(self, query: str) -> CommandResult:
        return await self._namespace.command("find", query=query)

    async def create(self, spec: dict[str, Any]) -> CommandResult:
        return await self._namespace.command("create", spec=spec)

    async def update(self, ref: Any, changes: dict[str, Any]) -> CommandResult:
        return await self._namespace.command("update", ref=ref, changes=changes)

    async def delete(
        self,
        ref: Any,
        *,
        idempotency_key: str | None = None,
        confirm_mutation: bool = False,
    ) -> CommandResult:
        options = {
            **({} if idempotency_key is None else {"idempotencyKey": idempotency_key}),
            "confirmMutation": confirm_mutation,
        }
        return await self._namespace.command("delete", ref=ref, options=options)

    async def set_enabled(self, ref: Any, enabled: bool, *, idempotency_key: str | None = None) -> CommandResult:
        options = {} if idempotency_key is None else {"idempotencyKey": idempotency_key}
        return await self._namespace.command("setEnabled", ref=ref, enabled=enabled, options=options)

    async def runs(self, ref: Any) -> CommandResult:
        return await self._namespace.command("runs", ref=ref)

    async def run_now(self, ref: Any, *, idempotency_key: str | None = None) -> CommandResult:
        options = {} if idempotency_key is None else {"idempotencyKey": idempotency_key}
        return await self._namespace.command("runNow", ref=ref, options=options)


class AsyncDevWorkerClient:
    def __init__(self, request: AsyncRequester) -> None:
        self._namespace = _AsyncDevNamespace(request, "worker")

    async def start(self, spec: dict[str, Any]) -> CommandResult:
        return await self._namespace.command("start", spec=spec)

    async def stop(self, ref: Any) -> CommandResult:
        return await self._namespace.command("stop", ref=ref)

    async def status(self, ref: Any) -> CommandResult:
        return await self._namespace.command("status", ref=ref)

    async def list(self) -> CommandResult:
        return await self._namespace.command("list")


class AsyncDevAutonomousClient:
    def __init__(self, request: AsyncRequester) -> None:
        self._namespace = _AsyncDevNamespace(request, "autonomous")

    async def plan(self, spec: dict[str, Any], *, options: dict[str, Any] | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {"spec": spec}
        if options is not None:
            args["options"] = options
        return _record(await self._namespace.raw("plan", **args), label="autonomous.plan")

    async def bootstrap(self, spec: dict[str, Any], *, options: dict[str, Any] | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {"spec": spec}
        if options is not None:
            args["options"] = options
        return _record(await self._namespace.raw("bootstrap", **args), label="autonomous.bootstrap")

    async def create(self, plan: dict[str, Any]) -> dict[str, Any]:
        return _record(await self._namespace.raw("create", plan=plan), label="autonomous.create")

    async def get(self, workflow_id: str) -> dict[str, Any]:
        return _record(await self._namespace.raw("get", workflowId=workflow_id), label="autonomous.get")

    async def advance(self, workflow_id: str, *, options: dict[str, Any] | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {"workflowId": workflow_id}
        if options is not None:
            args["options"] = options
        return _record(await self._namespace.raw("advance", **args), label="autonomous.advance")

    async def run(self, workflow_id: str, *, options: dict[str, Any] | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {"workflowId": workflow_id}
        if options is not None:
            args["options"] = options
        return _record(await self._namespace.raw("run", **args), label="autonomous.run")

    async def resume_task(self, workflow_id: str, task_id: str) -> dict[str, Any]:
        return _record(
            await self._namespace.raw("resumeTask", workflowId=workflow_id, taskId=task_id),
            label="autonomous.resumeTask",
        )


class AsyncDevClient:
    def __init__(self, request: AsyncRequester) -> None:
        self.projects = AsyncDevProjectsClient(request)
        self.planner = AsyncDevPlannerClient(request)
        self.worker = AsyncDevWorkerClient(request)
        self.autonomous = AsyncDevAutonomousClient(request)
