# agent-skills

Claude Code / Codex CLI で使う Agent Skills 置き場。各スキルは `<name>/SKILL.md` を持つディレクトリ。

## スキル一覧

| スキル | 内容 |
|---|---|
| `consulting-slides` | 経営層向けの戦略コンサルティング資料を HTML スライド（16:9）で作成する。24種の図解パターン、ヘッドレス Chrome による全ページ画像検証つき |

## セットアップ（各端末で1回）

```bash
git clone git@github.com:KosukeShiraki/agent-skills.git ~/agent-skills
mkdir -p ~/.claude/skills ~/.codex/skills
ln -s ~/agent-skills/consulting-slides ~/.claude/skills/consulting-slides   # Claude Code
ln -s ~/agent-skills/consulting-slides ~/.codex/skills/consulting-slides    # Codex CLI
```

更新は `cd ~/agent-skills && git pull`。

## 依存

- Python 3
- Google Chrome または Chromium（`consulting-slides/scripts/render.py` の画像検証に使用。WSL では Windows 版 Chrome を自動で使う）
