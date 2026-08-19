PREFIX ?= $(HOME)/.local
BIN    := $(PREFIX)/bin/yagami

.PHONY: all build install update

all: build install

build:
	bun install
	bun run build

install:
	@mkdir -p $(PREFIX)/bin
	@chmod +x dist/cli.js
	@ln -sf $(CURDIR)/dist/cli.js $(BIN)
	@echo "installed $(BIN) -> $(CURDIR)/dist/cli.js"

update:
	@RUNNING=""; \
	if $(BIN) status >/dev/null 2>&1; then RUNNING=1; fi; \
	if [ -n "$$RUNNING" ]; then \
		echo "stopping running yagami server"; \
		$(BIN) stop || true; \
	fi; \
	rm -f $(BIN); \
	$(MAKE) build install; \
	if [ -n "$$RUNNING" ]; then \
		$(BIN) start --daemon; \
	fi
