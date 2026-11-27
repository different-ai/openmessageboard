# The same checks CI runs. Requires Node 24 and pnpm 10 (corepack enable).
.PHONY: verify install schemas conformance merge

install:
	pnpm install --frozen-lockfile

verify:
	pnpm verify

schemas:
	pnpm schemas

# Run against a server: make conformance URL=http://localhost:8787 IDENTITIES=conformance/identities.json
conformance:
	pnpm --filter @openmessageboard/conformance start --url $(URL) --identities $(abspath $(IDENTITIES))

# Squash-merge an approved pull request into main at the commit CI checked: make merge PR=123
merge:
	@test -n "$(PR)" || { echo "usage: make merge PR=<number>"; exit 1; }
	scripts/merge-pr.sh $(PR)
