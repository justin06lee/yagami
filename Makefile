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
	@RUNNING=$$(pgrep -f "yagami(.js)? start" || true); \
	if [ -n "$$RUNNING" ]; then \
		echo "stopping running yagami server"; \
		pkill -f "yagami(.js)? start" || true; \
	fi; \
	rm -f $(BIN); \
	$(MAKE) build install; \
	if [ -n "$$RUNNING" ]; then \
		echo "restarting yagami server (log: /tmp/yagami.log)"; \
		nohup $(BIN) start >/tmp/yagami.log 2>&1 & \
	fi
