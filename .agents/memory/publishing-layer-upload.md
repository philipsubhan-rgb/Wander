---
name: Publishing layer upload failures
description: Diagnoses closed-pipe publishing failures that occur after all workspace artifact builds complete.
---

If publishing reaches the image-layer push stage and fails with an `io.Copy` or `read/write on closed pipe` error, treat it as a publishing transport or compute-environment interruption unless the logs also show an application build or startup failure.

**Why:** The workspace artifacts can finish compiling and bundling successfully, while the container image upload fails before promotion. A prior attempt may succeed with the same project and payload.

**How to apply:** Confirm the latest build has no earlier build-command failure, retry Publish, and restart the project compute environment before retrying again if the same layer-upload error repeats. Escalate as an infrastructure issue after repeated retries.