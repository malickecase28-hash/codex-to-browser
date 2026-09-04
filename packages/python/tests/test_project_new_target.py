from __future__ import annotations

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
