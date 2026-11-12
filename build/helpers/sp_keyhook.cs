using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class SPKeyHook {
  delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)]
  struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto)] static extern IntPtr GetModuleHandle(string lpModuleName);
  [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] static extern sbyte GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG lpMsg);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG lpMsg);

  const int WH_KEYBOARD_LL = 13;
  const uint WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
  static readonly UIntPtr MAGIC = (UIntPtr)0x53504B31;
  static HookProc proc = Callback;
  static IntPtr hook = IntPtr.Zero;
  static int prefixVk = 0xDC;
  static int holdMs = 100;
  static bool prefixDown = false;
  static bool passthrough = false;
  static bool armed = false;
  static bool used = false;
  static int blockedVk = 0;
  static Timer timer = null;
  static Timer disarmTimer = null;
  static readonly object gate = new object();

  static bool ModifierDown() {
    return (GetAsyncKeyState(0x10) & 0x8000) != 0 || (GetAsyncKeyState(0x11) & 0x8000) != 0 ||
           (GetAsyncKeyState(0x12) & 0x8000) != 0 || (GetAsyncKeyState(0x5B) & 0x8000) != 0 ||
           (GetAsyncKeyState(0x5C) & 0x8000) != 0;
  }

  static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
      if (k.dwExtraInfo == MAGIC) return CallNextHookEx(hook, nCode, wParam, lParam);
      int vk = (int)k.vkCode;
      long msg = wParam.ToInt64();
      bool down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
      bool up = msg == WM_KEYUP || msg == WM_SYSKEYUP;

      if (vk == prefixVk) {
        if (down) {
          if (prefixDown) return (IntPtr)1;
          if (ModifierDown()) { passthrough = true; return CallNextHookEx(hook, nCode, wParam, lParam); }
          prefixDown = true; armed = false; used = false; blockedVk = 0;
          lock (gate) {
            if (timer != null) timer.Dispose();
            if (disarmTimer != null) { disarmTimer.Dispose(); disarmTimer = null; }
            timer = new Timer(OnHold, null, holdMs, Timeout.Infinite);
          }
          return (IntPtr)1;
        }
        if (up) {
          if (passthrough) { passthrough = false; return CallNextHookEx(hook, nCode, wParam, lParam); }
          if (!prefixDown) return CallNextHookEx(hook, nCode, wParam, lParam);
          prefixDown = false;
          bool wasArmed;
          lock (gate) {
            wasArmed = armed;
            if (timer != null) { timer.Dispose(); timer = null; }
          }
          if (!wasArmed && !used) {
            keybd_event((byte)prefixVk, 0, 0, MAGIC);
            keybd_event((byte)prefixVk, 0, 2, MAGIC);
            armed = false;
          } else if (used) {
            armed = false;
          } else {
            // префикс уже сработал: даём 1.2 с, чтобы нажать клавишу даже
            // после отпускания префикса (привычка «нажал \ — нажал клавишу»)
            lock (gate) {
              if (disarmTimer != null) disarmTimer.Dispose();
              disarmTimer = new Timer(OnDisarm, null, 1200, Timeout.Infinite);
            }
          }
          return (IntPtr)1;
        }
      }

      if (blockedVk != 0 && vk == blockedVk) {
        if (down) return (IntPtr)1;              // автоповтор второй клавиши
        if (up) { blockedVk = 0; return (IntPtr)1; }
      }

      if (armed) {
        if (down) {
          armed = false; used = true; blockedVk = vk;
          lock (gate) {
            if (disarmTimer != null) { disarmTimer.Dispose(); disarmTimer = null; }
          }
          Console.Out.WriteLine("KEY " + vk);
          Console.Out.Flush();
          return (IntPtr)1;
        }
        if (up && vk == blockedVk) { blockedVk = 0; return (IntPtr)1; }
      }
    }
    return CallNextHookEx(hook, nCode, wParam, lParam);
  }

  static void OnHold(object state) {
    lock (gate) {
      if (!prefixDown) return;
      armed = true;
    }
    Console.Out.WriteLine("ARM");
    Console.Out.Flush();
  }

  static void OnDisarm(object state) {
    lock (gate) {
      armed = false;
      blockedVk = 0;
      if (disarmTimer != null) { disarmTimer.Dispose(); disarmTimer = null; }
    }
  }

  public static void Main(string[] args) {
    if (args.Length > 0) int.TryParse(args[0], out prefixVk);
    if (args.Length > 1) int.TryParse(args[1], out holdMs);
    if (holdMs < 20) holdMs = 100;
    hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
    Console.Out.WriteLine(hook == IntPtr.Zero ? ("HOOKFAIL " + Marshal.GetLastWin32Error()) : "HOOKOK");
    Console.Out.Flush();
    if (hook == IntPtr.Zero) return;
    Thread watch = new Thread(() => {
      try { while (Console.In.ReadLine() != null) { } } catch { }
      Environment.Exit(0);
    });
    watch.IsBackground = true;
    watch.Start();
    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
      TranslateMessage(ref msg);
      DispatchMessage(ref msg);
    }
    UnhookWindowsHookEx(hook);
    hook = IntPtr.Zero;
  }
}