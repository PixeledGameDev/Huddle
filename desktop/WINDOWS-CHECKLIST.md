# Windows checklist for a desktop release

Everything below needs a real Windows computer (the automatic tests can't try the tray, notifications, the taskbar or the installer).
Install the build over the previous version, sign in, and tick these off. Each line says what you should see.

## Basics
- [ ] The installer runs; Huddle opens signed in. Windows SmartScreen may warn on a first install (the app is unsigned): that is expected.
- [ ] Close the window: Huddle stays in the tray. Click the tray icon: the window returns.
- [ ] Huddle menu → **Troubleshooting → Copy debug info**: paste it somewhere. It shows versions, settings and the latest log lines, and nothing private.
- [ ] **Troubleshooting → Open logs folder** opens `%APPDATA%\Huddle\logs` with `huddle.log` in it.

## Updates
- [ ] With the previous version installed and Huddle left running in the tray, publish the new version. Within about 45 minutes (or when you open the window) a **Huddle popup** says an update is ready, with **Restart now** and **Later**.
- [ ] **Later** closes the popup; the tray menu has "Restart to update to …" at the top and the tray tooltip says "update ready".
- [ ] **Restart now** installs it and reopens Huddle; the **What's new** window lists the changes.

## Idle status and quiet hours
- [ ] Profile → **Desktop app** → set "Show me as Idle" to 5 minutes. Leave the computer alone, and from a second account (or your phone) check you show as Idle. Move the mouse: you are Online again.
- [ ] Lock the screen (Win+L): you show as Idle at once; unlock: back to Online. If you are on Do not disturb or Invisible, nothing changes.
- [ ] Profile → **Notifications** → turn on Quiet hours for the current time. Have someone message you: no popup, no sound, but the unread badge still counts. "Send a test" still works.

## Links, taskbar and right-click
- [ ] In a browser, open an invite link; click **Open this invite there**. Huddle opens on the invite page (you still click to join). Try it with the window closed to the tray too.
- [ ] Right-click the Huddle taskbar icon: **Open Huddle**, **Check for updates**, **Quit Huddle** (the last one also removes the tray icon).
- [ ] Upload a large file (20 MB or more): the taskbar button shows a progress bar, then clears.
- [ ] Type a misspelled word, right-click it: suggestions and **Add "…" to dictionary**. Right-click a picture in a message: **Copy image** and **Save image as…**.

## Keyboard shortcuts
- [ ] Profile → Desktop app → **Keyboard shortcuts**: click one, press for example Ctrl+Alt+H. It shows "Active".
- [ ] Press it in another program: Huddle comes to the front; press again: it goes to the tray. Try the other two with Huddle in the tray (page unloaded after a few minutes hidden): **Quick switcher** opens the search; **Jump to next unread** opens the oldest unread message or mention.
- [ ] Choose a combination another program already uses: Huddle says so. Uninstall/reinstall is not needed.

## Crash recovery
- [ ] Optional: in Task Manager, end one of the "Huddle" processes that uses the most memory (the page). The window reloads by itself after a moment.
