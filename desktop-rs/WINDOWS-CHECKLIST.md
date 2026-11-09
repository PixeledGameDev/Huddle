# Windows checklist (do this before replacing the Electron app)

The Rust app was written and run on Linux. Everything below needs a real Windows 10/11 computer.

**Build**
- [ ] `cargo build` and `cargo test` succeed on Windows. Fix any compile error in the `#[cfg(windows)]` blocks first
      (`src/platform.rs`: `register_protocol`, `work_area`; `src/app.rs`: `beep`, the `badge` branch, `popup_huddle_menu`, toast window builder;
      `src/update.rs`: `launch_installer`).
- [ ] The installer builds (`cargo packager --release`) and installs for the current user without asking for admin.
- [ ] WebView2 is present (Windows 11 and updated Windows 10 have it; the installer should install it otherwise).

**First run**
- [ ] The splash shows, then the server-address page (or Huddle, if `HUDDLE_DEFAULT_URL` was built in). A wrong address shows the error text.
- [ ] Dragging the title bar moves the window (WebView2's own `app-region: drag`); double-click maximizes; the three buttons work; the window can be resized from its edges.
- [ ] Window size/position and "maximized" are remembered. Unplugging a monitor doesn't leave it off-screen.
- [ ] The logo menu opens under the logo at the right place (also at 125% / 150% display scaling).

**Page features**
- [ ] A direct message / @mention shows the reply popup in the bottom-right corner *above the taskbar*, without taking focus from what you are typing.
- [ ] Reply, Mark as read, Open and the close button work; two messages in one channel update one popup.
- [ ] The taskbar shows the unread number (overlay icon) and clears when read; the tray icon gets its red dot; upload progress shows on the taskbar button.
- [ ] Quiet hours silence popups, sound and flashing.
- [ ] Global shortcuts: set one in Profile → Desktop app; it works from another program and while Huddle is in the tray; a taken one is reported.
- [ ] Idle: leave the keyboard alone for the chosen time; others see Idle; moving the mouse brings you back.

**Tray / memory**
- [ ] Closing the window hides to the tray (if enabled); the tray click reopens it; Quit really quits (check Task Manager: no leftover `msedgewebview2.exe` from Huddle).
- [ ] After ~2 minutes hidden, the page is freed and popups still arrive; clicking one reopens the right conversation; replying from a popup while freed works.
- [ ] Memory usage… and Copy debug info work; the debug text has no messages or sign-in details.

**Links, startup, updates**
- [ ] `huddle://invite/CODE` from a browser opens the invite in the running app (and starts the app if it isn't running).
- [ ] Start-with-computer and start-in-background work after a sign-out/sign-in.
- [ ] Running the program twice shows the first window instead of a second.
- [ ] Update: publish a higher version; the splash shows the download, the app restarts into the new version by itself, and the new version opens.
      Also test a bad download (changed file) is refused, and that a *running* app shows the "Restart now / Later" popup.
- [ ] Antivirus/SmartScreen behaviour of the unsigned installer is acceptable (same as the Electron one).

**Moving users over from Electron**
- [ ] Installing 3.x over a 2.x Electron install: decide whether the old app is uninstalled (different install folder/app id) and tell people they
      need to sign in again and re-import custom themes.
