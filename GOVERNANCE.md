# Governance

This document clarifies project ownership and collaboration expectations so contributors can work together with fewer ambiguities.

## 0. Fork note
- This checkout is the LinKy fork maintenance branch for personal learning,
  compatibility fixes, regression validation, and documentation refresh.
- The fork keeps the original author attribution, original repository link, and
  ISC license notice.
- Fork-specific fixes should be documented in README and `changelog/` so users
  can distinguish them from upstream releases.

## 1. Upstream ownership
- The original upstream/source project is `YanHaidao/wecom`.
- **Author & Lead Maintainer:** YanHaidao (GitHub: YanHaidao).

## 2. Co-maintenance model
- Tencent Cloud contributors are welcome as **co-maintainers** for code, docs, testing, and cloud deployment adaptation.
- Tencent Cloud may host an official mirror repository for sync and downstream integration needs.
- LinKy is credited for this fork's compatibility-fix validation, maintenance
  notes, and documentation refresh.

## 3. Decision-making
- We prefer discussion and consensus on non-trivial changes.
- If consensus is not reached in time, the Lead Maintainer makes the final upstream decision for roadmap, architecture, and release direction.

## 4. Contribution workflow
- Non-trivial changes should be proposed via Pull Request.
- Keep change scope clear, include test notes when relevant, and document behavior changes.

## 5. Mirrors and downstream adaptations
- Mirrors may carry downstream patches (for example deployment integration or cloud templates).
- Mirrors/downstream repositories should keep attribution in README or NOTICE:
  - Upstream source: YanHaidao/wecom
  - Author: YanHaidao
  - Co-maintained with Tencent Cloud contributors
  - Fork maintenance/contribution, when applicable: LinKy
