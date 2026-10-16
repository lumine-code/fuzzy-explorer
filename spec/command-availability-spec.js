describe("fuzzy-explorer captured editor availability", () => {
  let main, editor, window;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("fuzzy-explorer")).mainModule;
    editor = lumine.workspace.buildTextEditor();
    window = {};
    main.windowLists.set(window, { opening: { editor } });
  });
  afterEach(() => {
    main.windowLists.delete(window);
    editor.destroy();
  });
  it("keeps source editor checks cached and distinguishes readonly copy from insertion", () => {
    const ensure = spyOn(main, "ensureSelectList").and.throwError("query ensured UI"),
      commands = main.listCommands(window);
    expect(commands["fuzzy-explorer:insert-absolute-path"].isAvailable({})).toBe(true);
    editor.setReadOnly(true);
    expect(commands["fuzzy-explorer:insert-absolute-path"].isAvailable({})).toBe(false);
    expect(commands["fuzzy-explorer:copy-relative-path"].isAvailable({})).toBe(true);
    main.windowLists.get(window).opening.editor = null;
    expect(commands["fuzzy-explorer:copy-relative-path"].isAvailable({})).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
  });
  it("uses cached directory metadata in action predicates", () => {
    main.pathKinds.set("/cached/folder", true);
    const fs = require("node:fs"),
      stat = spyOn(fs, "lstatSync").and.throwError("availability stat");
    try {
      const actions = main.listActions();
      expect(
        actions.find((a) => a.command === "fuzzy-explorer:open").when({ item: "/cached/folder" }),
      ).toBe(false);
      expect(
        actions
          .find((a) => a.command === "fuzzy-explorer:query-selected-path")
          .primary({ item: "/cached/folder" }),
      ).toBe(true);
      expect(stat).not.toHaveBeenCalled();
    } finally {
      stat.and.callThrough();
    }
  });
});
