# Phase 3 真实会话操作指引（知识段 → idea 段）

> 用途：在**真实会话**里跑通 cv-research 的完整链路，并让每一步的产物可核对。
> 这份指引是给"人"看的操作手册——每步给出**可直接复制的提示词**、**预期结果**、
> **常见故障与判读**。设计与实现依据见 `CV-Research-Agent_勘误与修订设计-v1.3.md`。

## 0. 前置（每次重启宿主后做一次）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-dsh-web.ps1 -DryRun   # 自检
```

要看到：`ASTA_API_KEY 已设置`、`代理端口 在监听`、`连接 Asta 预检 通过`、两个 skill 根都存在。

启动宿主（双击桌面「启动 CV-Research」或跑上面的命令去掉 `-DryRun`），然后：
**新开一个会话 → 选 `CV Research Orchestrator`**。

工具目录自检（可选，但建议）：
```bash
node scripts/check-tool-catalog.mjs --with-asta   # 期望：cvagent 21 个 + Asta 8 个
```

> ⚠️ 别用裸 `dsh web` 启动：它不注入前置，而缺失的后果是**静默的**（检索工具消失、skill 根失效）。

---

## 1. 定范围（`cvagent_scope_set`）

先让 Orchestrator 与你确认细分领域，再落盘。**可以直接把下面整段发给它**：

```
我要开始一个新课题。请先问我 2–3 个问题把研究范围收敛清楚（细分领域、要解决的问题、
必须覆盖/排除的模态或数据集），然后调用 cvagent_scope_set 把结论落盘：
sub_domain 写一句话，keywords 写 3–8 个（中英兼顾、含同义表述）。
落盘后把 cvagent_state_get 的结果念给我看一遍，确认 sub_domain 与 keywords 都对了。
先不要检索。
```

**预期**：`scope_ready: true`，`keywords` 5–8 条。
**为什么必须先做**：知识阶段的判据里，`sub_domain` 未确定则**一律不放行**（这是刻意的——
检索范围没定就谈"知识建成"没有意义）。

> ⚠️ **顺序很重要**：落盘范围的那一刻会记下**口径基线**（当时的存量快照）——见
> 勘误 §12.11 的方案 C。库里已有的语料**不会**帮你过门控，门控只认"落盘之后新增"。
> 所以**先落范围、再检索入库**；反过来做（先攒语料后落范围）会让基线等于语料本身，
> `advance` 会一直报 `论文库新增 0/100 篇（存量 390，基线 390）`。
> 这不是故障，是刻意语义；真要重新计时，就再调一次 `cvagent_scope_set`（**改一个关键词**
> 即可触发重新记基线）。

---

## 2. 检索入库（`cvagent_kb_scout` → `cvagent_kb_import_papers`）

```
现在做检索。用 cvagent_kb_scout 取回候选（max_results=60，
extra_instructions 里写明"优先近三年、必须带 DOI 或 arXiv ID"）。
拿到结果后：
1) 先把 count 与 with_external_id 报给我；
2) 直接把我确认要的那批用 cvagent_kb_import_papers 入库（source_channel=asta），
   并把 inserted / merged / needs_review / failed 四个数报给我；
3) 然后调 cvagent_kb_summary，把论文库与已解析/已提取的数字报给我。
```

**预期**：`with_external_id` ≈ count（无外部 ID 的候选被工具自动剔除，不入 `import_json`）；
入库后 `papers` 明显增长。
**判读**：
- `count` 很小（<10）→ 检索词太窄，回到第 1 步加关键词；
- `with_external_id` 远小于 `count` → 说明 Scout 返回了很多没有 ID 的条目（工具会丢掉它们，
  这是对的：标题无法唯一标识，去重会错）；
- 入库全是 `merged` → 说明这批论文库里已经有了（换个角度或看下一句）。

---

## 3. 解析（MinerU，脚本侧，不在会话里）

会话不负责解析——解析是**落盘流水线**，跑脚本（额度 2000 页/天）：

```bash
node scripts/batch-parse.mjs --dry-run     # 先看计划与额度预算
node scripts/batch-parse.mjs               # 正式跑（可中断，用 --resume 续）
node scripts/check-md-paths.mjs            # 完整性：md_path 是否都能读
```

> 中断/代理掉线都不要紧：`--resume` 只轮询+落库，**不重复提交、不重复计费**；
> MinerU 侧已 done 但本地没落库时用 `--resume-batch <batch_id>` 定向补收。

---

## 4. 结构化提取（`cvagent_kb_extract`，每篇一次委派）

```
对论文库里"已解析但还没提取"的论文做结构化提取，一次 5 篇、串行做。
每篇调用 cvagent_kb_extract(paper_id=...)，把返回的 extraction_quality 与一句话摘要报给我，
失败的记下 paper_id 与原因，不要重试超过一次。
做完后调 cvagent_kb_summary 报已提取篇数。
```

**预期**：`extractions` 增长；每篇返回结构化三字段。
**判读**：报"论文尚未解析" → 该篇 `md_path` 为空，回第 3 步；报"未按契约应答" →
子代理没按 outputSchema 回（可重试一次；连续出现说明该篇 Markdown 有问题，先跳过）。

---

## 5. 归纳成库条目（`cvagent_kb_analyze`）

```
现在做归纳。用 cvagent_kb_analyze 处理上一步提取过的论文（一次 5 篇）。
先 dry_run=true 跑一次，把 proposed / skipped 与小节标题清单报给我，我确认后再正式写库。
正式写库时把 created / merged 报给我，并列出被合并（merged=true）的条目 ID——
那些是"与既有条目撞车"的信号，我想看看是真正的重复还是表述不同。
```

**预期**：`dry_run` 的 `proposed` 合理（每篇 2–5 条）；正式写库后四库计数增长，`merged` 少量。
**判读**：`skipped` 多 → Analyst 产出的形状不合规（缺 `source_papers` 或库名非法），
看 `skipped` 数是否 >proposed 的 30%；`merged` 很多 → 说明库里已覆盖这个话题。

---

## 6. 阶段门控（`cvagent_state_advance`）

```
请调 cvagent_state_advance，把本次知识构建的摘要写进去
（含论文库总数、已解析、已提取、四库条目数），
然后逐条念 missing 清单与 facts_json，不要替我判断"差不多够了"。
如果达标，按当前模式走门控：A 模式下先用 ask_user_question 问我，再 cvagent_gate_resolve。
```

**预期**：达标 → `gate_requested: true`；不达标 → `missing` 里是**具体数字**（如 `论文库 12/100 篇`），
照单补齐即可（`facts_json` 就是判据依据，可核对）。

---

## 7. 冻结 Domain Pack（`cvagent_domain_bootstrap` → `cvagent_domain_freeze`）

```
现在冻结领域包：
1) cvagent_domain_bootstrap 派生草案，把 summary_json（各库字段、benchmark/术语数、权重与阈值）
   和 contract_problems 报给我；
2) 我要看三处：enum 词表、benchmarks 纳入/排除清单、权重与档位——把这三项完整念给我；
3) 我确认后，用 cvagent_domain_freeze(reviewer="<我的标识>", bind=true) 冻结。
```

**判读**：`contract_problems` 非空 → **不许冻结**（工具会拒），按提示修；
冻结成功会回 `content_hash`（审计用）。
> 冻结是**人工评审门**：签名空着会被 core 直接拒（v1.2 §3.4.4 不可豁免）。
> 之后要改 pack，走 `cvagent_domain_propose_revision` 升版本——旧绑定不受影响。

---

## 8. idea 生成与打分（`cvagent_idea_generate` → `cvagent_idea_score`）

```
现在做 idea 段。
1) 用 cvagent_idea_generate（max_lenses=3、ideas_per_lens=2）生成候选，
   把 per_lens 的状态（ok/duplicate/empty/error）与候选清单报给我；
2) 我挑 2 条，你逐条调 cvagent_idea_score；
3) 如果返回 status=needs_external_evidence，就用 mcp__asta__snippet_search 补外部证据
   （把结果整理成 [{"ref_id","statement","similarity"}] 传回 external_evidence 再调一次）；
4) 最后把两条的打分报告并排报给我：total / 四维分 / suggestion / risk_level /
   failure_blocked_by / failure_waivers / report_consistent。
```

**预期**：报告自洽（`report_consistent: true`）；`evidence` 里能看到逐条撞车判定（含失败的先例）。
**判读**：
- `pack_frozen: false` → 第 7 步没做，权重是草案值（报告里会带告警）；
- `failure_blocked_by` 非空 → 命中失败方法库且裁判认为条件仍成立：这条 idea 应先改设计；
- `failure_waivers` 非空 → 裁判认为失败条件已变（理由要能说服你）；
- 全部 `suggestion: abandon/revise` → 说明该视角已被做透（这本身是有价值的结论）。

---

## 9. 常见故障速查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| cv-research 会话里一个 `cvagent_*` 都没有 | preset 挂载失败（一行坏掉全份挂载失败，E19/E30） | ① `node scripts/check-preset.mjs` 看结构；② `node scripts/probe-preset-rows.mjs` 在新进程里逐行试挂（**能给出与宿主逐字相同的报错**，如 `cannot get property "systemPrompt" without inject`）；③ 看宿主窗口的报错 |
| `advance` 报「论文库**新增** 0/100（存量 390，基线 390）」 | **不是故障**：口径基线在起作用（方案 C），存量不算数 | 想让新语料计入，先 `cvagent_scope_set` 落下本课题范围再检索；或改一个关键词重新记基线 |
| Scout 报 `Cannot read properties of undefined (reading 'aborted')` | 委派请求漏传必填的 `signal`（E31） | 已修；若复现请连同 `node packages/dsh-plugin/tests/names.test.mjs` 一起回报——`tests/subagent-contract.test.ts` 会守住调用点 |
| 有 `cvagent_*` 但没有 `mcp__asta__*` | 前置缺失（key / 代理 / `NODE_USE_ENV_PROXY`） | `start-dsh-web.ps1 -DryRun` 逐项检查后重启宿主 |
| 改了 preset/插件但行为没变 | 运行中的宿主缓存模块与 exports（E21） | 重启宿主 |
| `advance` 永远不达标 | 判据读的是真实数字：`sub_domain` / 论文 / 解析 / 提取 / 四库条目 | 看 `facts_json` 对号入座 |
| 检索召回很差 | 关键词太窄，或用了 `search_papers_by_relevance`（它的 `limit` 不生效） | 加 `lexicon.query_expansion` 里的同义表述；批量发现用 `snippet_search` |
| 打分报告里 `retrieval_mode: keyword_only` | 尚未接入 embedding（当前设计如此） | 语义撞车靠裁判——这是刻意的分工，不是故障 |
