from typing import Literal

JobStatus = Literal["running", "awaiting", "queued", "steered", "completed", "failed", "aborted"]

__all__ = ["JobStatus"]
