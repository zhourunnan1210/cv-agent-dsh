# EVIDENCE —— 数字溯源

> 硬规则：论文/报告里出现的**每个数字**都要在这里有一行，来源必须到「文件 + 字段」。
> 来自论文引用的数字写 `paper:<paper_id>` 并注明表号/页码。
> 校验：`node scripts/check-experiment.mjs experiments/E0xx-short-slug`（本表每行须含 `runs/` 或 `paper:`）

| 数字 | 含义 | 来源 | 复现命令 |
| --- | --- | --- | --- |
| 0.932 | 示例：FF++ c23 帧级 AUC | runs/20260917-1432-a1b2c3d/metrics.json#auc | `python code/eval.py --run 20260917-1432-a1b2c3d` |
| 0.874 | 示例：Celeb-DF 跨库 AUC（论文报告值） | paper:10.1109/cvpr52688.2022.01816（表 3） | — |
