# diagnostics (TEMP)

Workflow trung gian: reset staging ve main HEAD khi main di truoc (engine push)
va verify invariant. Report moi lan chay nam trong report.md. Xoa sau khi smoke
ladder xong.

Lan chay 2 (2026-10-02): staging repair — reset 3 nhanh staging ve main HEAD
sau khi 2 lan fail coordinator duoc chan doan la false-positive cua
contamination guard (staging branch history phan nhanh khoi main).
