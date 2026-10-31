.PHONY: test release

PACKAGE ?= taropi-core
REMOTE ?= origin
MESSAGE ?=

# test 运行 taropi-core 单元测试并生成本地覆盖率报告。
test:
	npm run test:coverage

# release 先拉取当前分支以暴露冲突，再递增指定 workspace 的补丁版本，提交当前工作区内容和可选发布消息，并推送当前 GitHub 分支。
release:
	@case "$(PACKAGE)" in taropi-core|taropi-hud) ;; *) echo "不支持的 PACKAGE: $(PACKAGE)"; exit 1;; esac
	@branch="$$(git branch --show-current)"; test -n "$$branch" || { echo "当前不在分支上，无法发布。"; exit 1; }; \
	remote_url="$$(git remote get-url "$(REMOTE)")"; case "$$remote_url" in *github.com*) ;; *) echo "$(REMOTE) 不是 GitHub 远端：$$remote_url"; exit 1;; esac; \
	git pull --autostash --no-edit "$(REMOTE)" "$$branch" || { echo "拉取失败或存在冲突，已停止发布。"; exit 1; }; \
	npm version patch --workspace="$(PACKAGE)" --no-git-tag-version --ignore-scripts; \
	version="$$(node -p "require('./$(PACKAGE)/package.json').version")"; \
	git add -A; \
	commit_message="release v$$version"; \
	if test -n "$(MESSAGE)"; then commit_message="$$commit_message $(MESSAGE)"; fi; \
	git commit -m "$$commit_message"; \
	git push "$(REMOTE)" "HEAD:$$branch"
