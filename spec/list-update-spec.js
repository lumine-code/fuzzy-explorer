describe("fuzzy-explorer asynchronous list publication", () => {
  let main, release;
  beforeEach(async () => {
    jasmine.useRealClock();
    ({ mainModule: main } = await lumine.packages.activatePackage("fuzzy-explorer"));
    main.ensureSelectList();
    main.items = Object.freeze(["alpha"]);
    main.pending = true;
  });
  afterEach(async () => {
    release?.();
    release = null;
    await lumine.packages.deactivatePackage("fuzzy-explorer");
  });

  it("waits for asynchronous list filtering before finishing publication", async () => {
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    spyOn(main.selectList, "update").and.returnValue(gate);
    let settled = false;
    const publication = Promise.resolve(main.updateView(true)).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await publication;
    expect(settled).toBe(true);
  });

  it("reports a rejected asynchronous list update", async () => {
    const error = new Error("worker publication failed");
    const failure = Promise.reject(error);
    // Keep the old implementation's ignored promise from obscuring the assertion.
    void failure.catch(() => {});
    spyOn(main.selectList, "update").and.returnValue(failure);
    const report = spyOn(lumine.notifications, "addError");
    await main.updateView(true);
    expect(report).toHaveBeenCalledWith("Unable to update explorer files.", {
      detail: error.message,
      dismissable: true,
    });
  });

  it("ignores a failure from an update whose package has been deactivated", async () => {
    let reject;
    const gate = new Promise((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    void gate.catch(() => {});
    spyOn(main.selectList, "update").and.returnValue(gate);
    const report = spyOn(lumine.notifications, "addError");
    const publication = main.updateView(true);
    await lumine.packages.deactivatePackage("fuzzy-explorer");
    reject(new Error("retired update failed"));
    await publication;
    expect(report).not.toHaveBeenCalled();
  });

  it("reports synchronous source validation failures through the same error channel", async () => {
    spyOn(main.selectList, "update").and.throwError("invalid source");
    const report = spyOn(lumine.notifications, "addError");
    await main.updateView(true);
    expect(report).toHaveBeenCalledWith("Unable to update explorer files.", {
      detail: "invalid source",
      dismissable: true,
    });
  });

  it("preserves a replacement snapshot queued by a list observer", async () => {
    const replacement = Object.freeze(["beta"]);
    spyOn(main.selectList, "update").and.callFake(() => {
      main.items = replacement;
      main.pending = true;
      return Promise.resolve();
    });
    await main.updateView(true);
    expect(main.items).toBe(replacement);
    expect(main.pending).toBe(true);
  });
});
