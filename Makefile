.PHONY: test release

PACKAGE ?= taropi-core
REMOTE ?= origin

# test 运行 taropi-core 单元测试并生成本地覆盖率报告。
test:
	npm run test:coverage

# release 递增指定 workspace 的补丁版本，提交当前工作区内容并推送当前 GitHub 分支。
release:
	@case "$(PACKAGE)" in taropi-core|taropi-draw) ;; *) echo "不支持的 PACKAGE: $(PACKAGE)"; exit 1;; esac
	@branch="$$(git branch --show-current)"; test -n "$$branch" || { echo "当前不在分支上，无法发布。"; exit 1; }; \
	remote_url="$$(git remote get-url "$(REMOTE)")"; case "$$remote_url" in *github.com*) ;; *) echo "$(REMOTE) 不是 GitHub 远端：$$remote_url"; exit 1;; esac; \
	npm version patch --workspace="$(PACKAGE)" --no-git-tag-version --ignore-scripts; \
	version="$$(node -p "require('./$(PACKAGE)/package.json').version")"; \
	git add -A; \
	git commit -m "release v$$version"; \
	git push "$(REMOTE)" "HEAD:$$branch"
