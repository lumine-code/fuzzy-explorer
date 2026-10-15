const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CompositeDisposable } = require("lumine");

describe("fuzzy-explorer standard opening gestures", () => {
  let owner, host, model, items, scratch, alphaPath, betaPath, leases, external, open;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    scratch = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "fuzzy-explorer-gestures-")),
    );
    alphaPath = path.join(scratch, "Alpha.txt");
    betaPath = path.join(scratch, "Beta.txt");
    fs.writeFileSync(alphaPath, "Alpha content\n");
    fs.writeFileSync(betaPath, "Beta content\n");
    leases = new CompositeDisposable();
    const main = (await lumine.packages.activatePackage("fuzzy-explorer")).mainModule;
    owner = main;
    items = [alphaPath, betaPath];
    owner.items = items;
    spyOn(owner, "listSnapshot").and.returnValue({ items });
    host = owner.ensureSelectList();
    external = {
      openExternal: jasmine.createSpy("openExternal").and.resolveTo(""),
      showInFolder: jasmine.createSpy("showInFolder").and.resolveTo(""),
    };
    owner.openExternalService = external;
    spyOn(lumine.application, "openWindow").and.resolveTo();
    open = spyOn(lumine.workspace, "open").and.callThrough();
    model = host.getModel();
    await host.show();
    await model.selectItem(items[0]);
  });

  afterEach(async () => {
    leases.dispose();
    owner.openExternalService = null;
    await lumine.packages.deactivatePackage("fuzzy-explorer");
    await host.destroy();
    for (const editor of lumine.workspace.getTextEditors()) {
      if (editor.getPath()?.startsWith(scratch + path.sep)) editor.destroy();
    }
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), scratch);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(".." + path.sep)
    )
      throw new Error("Gesture fixture escaped the private temporary directory");
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function targetRow(item) {
    const id = model.getItemId(item);
    const index = model.getDisplayedItems().findIndex((current) => model.getItemId(current) === id);
    return model.getElement().querySelectorAll('[role="option"]')[index];
  }

  function nextAction() {
    return new Promise((resolve) => {
      const lease = model.onDidFinishAction((result) => {
        lease.dispose();
        resolve(result);
      });
    });
  }

  async function click(item, modifiers) {
    const finished = nextAction();
    targetRow(item)
      .querySelector(".primary-line")
      .dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          ...modifiers,
        }),
      );
    const result = await finished;
    await flushMicrotasks();
    return result;
  }

  function chooser(listener = jasmine.createSpy("choose")) {
    leases.add(lumine.commands.add("lumine-workspace", "launcher:open", listener));
    return listener;
  }

  it("Alt-clicks the clicked row into Launcher without invoking the ordinary action", async () => {
    const choose = chooser();
    const result = await click(items[1], { altKey: true });
    expect(result.status).toBe("success");
    expect(result.command).toBe("fuzzy-explorer:choose-opener");
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose.calls.mostRecent().args[0].detail.path).toBe(betaPath);
    expect(choose.calls.mostRecent().args[0].target).toBe(
      lumine.workspace.getMainWindow().getElement(),
    );
    expect(open).not.toHaveBeenCalled();
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
    expect(external.openExternal).not.toHaveBeenCalled();
  });

  it("opens the selected item chooser through Alt-Enter", async () => {
    const choose = chooser();
    await model.selectItem(items[1]);
    const finished = nextAction();
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: model.getQueryEditor().getElement() });
    lumine.keymaps.handleKeyboardEvent(event);
    const result = await finished;
    expect(result.command).toBe("fuzzy-explorer:choose-opener");
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose.calls.mostRecent().args[0].detail.path).toBe(betaPath);
    expect(open).not.toHaveBeenCalled();
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
  });

  it("keeps the finder's opening pane when another pane becomes active before Alt-click", async () => {
    const nativeChooser = (await lumine.packages.activatePackage("launcher")).mainModule;
    const openingPane = host.window.getEditorContainer().getActivePane();
    const otherPane = openingPane.splitRight();
    otherPane.activate();
    expect(host.window.getEditorContainer().getActivePane()).toBe(otherPane);
    try {
      const result = await click(items[1], { altKey: true });
      expect(result.status).toBe("success");
      const child = nativeChooser.pickers.get(host.window);
      expect(child.context.path).toBe(betaPath);
      expect(child.context.pane).toBe(openingPane);
      await child.host.getModel().selectItemById("text-editor");
      expect((await child.host.getModel().confirmSelection()).status).toBe("success");
      const editor = openingPane.getItems().find((item) => item.getPath?.() === betaPath);
      expect(editor.getText()).toBe("Beta content\n");
      expect(lumine.workspace.paneForItem(editor)).toBe(openingPane);
      expect(otherPane.getItems()).toEqual([]);
    } finally {
      await lumine.packages.deactivatePackage("launcher");
      otherPane.destroy();
    }
  });

  it("Ctrl-Alt-clicks only the external action for the clicked item", async () => {
    const result = await click(items[1], { ctrlKey: true, altKey: true });
    expect(result.command).toBe("fuzzy-explorer:open-external");
    expect(result.status).toBe("success");
    expect(external.openExternal.calls.allArgs()).toEqual([[betaPath]]);
    expect(external.showInFolder).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
  });

  it("Alt-Shift-clicks only the reveal action for the clicked item", async () => {
    const result = await click(items[1], { altKey: true, shiftKey: true });
    expect(result.command).toBe("fuzzy-explorer:show-in-folder");
    expect(result.status).toBe("success");
    expect(external.showInFolder.calls.allArgs()).toEqual([[betaPath]]);
    expect(external.openExternal).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
  });

  it("retains the picker and its native error after chooser failure", async () => {
    chooser(jasmine.createSpy("failed chooser").and.rejectWith(new Error("Chooser failed")));
    const result = await click(items[1], { altKey: true });
    expect(result.status).toBe("error");
    expect(model.getStatus()).toEqual({ type: "error", message: "Chooser failed" });
    expect(host.isVisible()).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
  });

  it("removes modifier listeners when a filtered row is retired", async () => {
    const choose = chooser();
    const retired = targetRow(items[1]);
    await model.setQuery("Alpha");
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      altKey: true,
    });
    retired.querySelector(".primary-line").dispatchEvent(event);
    await flushMicrotasks();
    expect(event.defaultPrevented).toBe(false);
    expect(choose).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(external.openExternal).not.toHaveBeenCalled();
  });

  it("resolves the standard opener and system-action keys locally", () => {
    const input = model.getQueryEditor().getElement();
    for (const [keystrokes, command] of [
      ["alt-enter", "fuzzy-explorer:choose-opener"],
      ["ctrl-alt-enter", "fuzzy-explorer:open-external"],
      ["alt-shift-enter", "fuzzy-explorer:show-in-folder"],
    ])
      expect(lumine.keymaps.findKeyBindings({ target: input, keystrokes })[0]?.command).toBe(
        command,
      );
  });

  for (const ctrlKey of [false, true])
    it(
      "uses " + (ctrlKey ? "Ctrl-Shift-click" : "Shift-click") + " only to select the clicked row",
      async () => {
        const actions = jasmine.createSpy("finished action");
        const lease = model.onDidFinishAction(actions);
        const event = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          shiftKey: true,
          ctrlKey,
        });
        targetRow(items[1]).querySelector(".primary-line").dispatchEvent(event);
        await flushMicrotasks();
        lease.dispose();
        expect(model.getItemId(model.getSelectedItem())).toBe(model.getItemId(items[1]));
        expect(event.defaultPrevented).toBe(true);
        expect(actions).not.toHaveBeenCalled();
        expect(host.isVisible()).toBe(true);
        expect(lumine.application.openWindow).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(external.openExternal).not.toHaveBeenCalled();
        expect(external.showInFolder).not.toHaveBeenCalled();
      },
    );

  it("exposes no Open Pending command or obsolete Enter alias", () => {
    const input = model.getQueryEditor().getElement();
    expect(
      lumine.commands
        .findCommands({ target: input })
        .some(({ name }) => name === "fuzzy-explorer:open-pending"),
    ).toBe(false);
    for (const keystrokes of ["shift-enter", "ctrl-shift-enter"]) {
      expect(
        lumine.keymaps
          .findKeyBindings({ target: input, keystrokes })
          .some((binding) => binding.command.startsWith("fuzzy-explorer:")),
      ).toBe(false);
    }
  });

  for (const pending of [false, true])
    it("keeps default file opening governed by the preview setting " + pending, async () => {
      lumine.config.set("core.allowPendingPaneItems", pending);
      const result = await click(items[1], {});
      expect(result.status).toBe("success");
      expect(result.command).toBe("fuzzy-explorer:open");
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.calls.mostRecent().args[1].pending).toBe(pending);
      expect(open.calls.mostRecent().args[1].opener).toBeUndefined();
      const editor = await open.calls.mostRecent().returnValue;
      expect(editor.getText()).toBe("Beta content\n");
      expect(lumine.workspace.paneForItem(editor).getPendingItem() === editor).toBe(pending);
    });
});
