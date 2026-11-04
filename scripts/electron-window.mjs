export function waitForBrowserWindow(application) {
  return application.waitForEvent('window', {
    predicate: async (page) => {
      let session;
      try {
        session = await page.context().newCDPSession(page);
        const { targetInfo } = await session.send('Target.getTargetInfo');
        // Playwright also emits this event for embedded WebContentsViews.
        return await application.evaluate(({ BrowserWindow, webContents }, targetId) => {
          const contents = webContents.fromDevToolsTargetId(targetId);
          return BrowserWindow.getAllWindows().some((window) => window.webContents === contents);
        }, targetInfo.targetId);
      } catch (error) {
        if (page.isClosed() || String(error).includes('has been closed')) return false;
        throw error;
      } finally {
        await session?.detach().catch(() => {});
      }
    },
  });
}
