# diagnostics (TEMP)

Workflow trung gian: lan 3 — chay next-pair --allocate (real) va dump rows
phan cong cho writer session doc. Xoa sau khi smoke ladder xong.

Lan 1: coordinator repro (exit codes).
Lan 2: staging repair — reset staging ve main HEAD.
Lan 3: allocate cycle cho smoke 1x1.
