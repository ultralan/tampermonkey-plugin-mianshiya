# tampermonkey-plugin-mianshiya

[Tampermonkey Base](https://github.com/ultralan/tampermonkey-base) 的面试鸭插件：进入题目详情页自动解析并幂等写入 Supabase 题库表。

## 工作方式

- 插件由基座客户端从注册中心发现并动态加载，**不需要单独安装**。只需安装基座客户端：
  [一键安装 Tampermonkey Base 客户端](https://fastly.jsdelivr.net/gh/ultralan/tampermonkey-base@published/client/tampermonkey-base.user.js)
- 进入 `mianshiya.com` 的题目详情页（`/question/<id>` 或 `/bank/<bankId>/question/<id>`）后，插件等待正文渲染完成，解析核心字段并 upsert 到 `tampermonkey_base.questions` 表
- 同一题重复访问覆盖更新；追问/扩展知识等段落未渲染（未登录/VIP）时对应字段为 null，带登录态重访自动补齐
- 顺带解除页面选择/复制限制

## 数据模型

| 字段 | 说明 |
|---|---|
| `question_id` | 主键，站点全局唯一题目 ID |
| `question_no` / `title` | 题号与标题（来自 h1） |
| `difficulty` / `is_vip` / `tags` | 难度、VIP 标记、标签 |
| `bank_ids` | 所属题库并集（URL bank 段 + 侧栏"所属题库"） |
| `answer_key` | `## 回答重点` 段 Markdown |
| `extended_knowledge` | `## 扩展知识` 段 Markdown（含子节） |
| `follow_ups` | `## 面试官追问` 的 `[{"q","a"}]` 数组 |
| `content_md` | 全页原始 Markdown |
| `content_hash` | 核心字段拼接的 sha256（不受评论区影响） |

## 发布

推送到 `main` 后 Actions 会：

1. 把 `plugin.user.js` 发布到本仓 `published` 分支（jsDelivr 可访问）；
2. 计算 sha256 并用 service role key upsert 注册表 `tampermonkey_base.plugins`，基座客户端下次刷新即自动加载新版本。

需要配置 secret：`TMB_SUPABASE_SERVICE_ROLE_KEY`（可选 `vars.TMB_SUPABASE_URL`）。

注册表中的 `enabled` 开关手动控制（Supabase 面板），发布流程不会改动它。

## Supabase 建表

在 Supabase SQL Editor 执行 `supabase/migrations/001_questions.sql`（依赖基座仓的 schema 初始化脚本）。
