'use strict'
// C# helper compiled once by Windows PowerShell (Add-Type) and kept running by tasks.cjs. Source of truth for the helper.
module.exports = { SOURCE: String.raw`using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;

public static class PagerProc
{
    [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int ret);
    [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr h);
    [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder sb, ref int size);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr tok);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr tok, int cls, IntPtr buf, int len, out int ret);
    delegate bool EnumProc(IntPtr hwnd, IntPtr lp);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);

    static IntPtr buf = IntPtr.Zero;
    static int bufLen = 0;
    static readonly Dictionary<long, long> sent = new Dictionary<long, long>();
    static readonly Stopwatch clock = Stopwatch.StartNew();
    static readonly CultureInfo inv = CultureInfo.InvariantCulture;

    static bool Query()
    {
        if (buf == IntPtr.Zero) { bufLen = 1 << 20; buf = Marshal.AllocHGlobal(bufLen); }
        for (int i = 0; i < 8; i++)
        {
            int need;
            int st = NtQuerySystemInformation(5, buf, bufLen, out need);
            if (st == unchecked((int)0xC0000004))
            {
                Marshal.FreeHGlobal(buf);
                bufLen = Math.Max(need + (256 << 10), bufLen * 2);
                buf = Marshal.AllocHGlobal(bufLen);
                continue;
            }
            return st >= 0;
        }
        return false;
    }

    static void Esc(StringBuilder sb, string s)
    {
        if (s == null) { sb.Append("null"); return; }
        sb.Append('"');
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c < 32 || c > 126) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        sb.Append('"');
    }

    static string CommandLine(int pid)
    {
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) return null;
        try
        {
            int len = 4096;
            for (int i = 0; i < 3; i++)
            {
                IntPtr b = Marshal.AllocHGlobal(len);
                try
                {
                    int need;
                    int st = NtQueryInformationProcess(h, 60, b, len, out need);
                    if (st == unchecked((int)0xC0000004) || st == unchecked((int)0xC0000023)) { len = Math.Max(need, len * 2); continue; }
                    if (st < 0) return null;
                    int l = (ushort)Marshal.ReadInt16(b, 0);
                    IntPtr s = Marshal.ReadIntPtr(b, 8);
                    if (l == 0 || s == IntPtr.Zero) return "";
                    return Marshal.PtrToStringUni(s, l / 2);
                }
                finally { Marshal.FreeHGlobal(b); }
            }
            return null;
        }
        finally { CloseHandle(h); }
    }

    public static string Sample(bool gpu)
    {
        if (!Query()) return "{\"error\":\"NtQuerySystemInformation failed\"}";
        var sb = new StringBuilder(64 * 1024);
        var neu = new StringBuilder(8 * 1024);
        long ts = clock.Elapsed.Ticks;
        sb.Append("{\"ts\":").Append(ts).Append(",\"p\":[");
        var seen = new HashSet<long>();
        bool first = true, firstNew = true;
        int off = 0;
        while (true)
        {
            IntPtr p = new IntPtr(buf.ToInt64() + off);
            int next = Marshal.ReadInt32(p, 0);
            long pid = Marshal.ReadIntPtr(p, 80).ToInt64();
            if (pid != 0)
            {
                int threads = Marshal.ReadInt32(p, 4);
                long mem = Marshal.ReadInt64(p, 8);
                long create = Marshal.ReadInt64(p, 32);
                long cpu = Marshal.ReadInt64(p, 40) + Marshal.ReadInt64(p, 48);
                seen.Add(pid);
                if (!first) sb.Append(',');
                first = false;
                sb.Append('[').Append(pid).Append(',').Append(threads).Append(',').Append(mem).Append(',').Append(cpu).Append(']');
                long known;
                if (!sent.TryGetValue(pid, out known) || known != create)
                {
                    sent[pid] = create;
                    long ppid = Marshal.ReadIntPtr(p, 88).ToInt64();
                    int nl = (ushort)Marshal.ReadInt16(p, 56);
                    IntPtr nb = Marshal.ReadIntPtr(p, 64);
                    string name = nl > 0 && nb != IntPtr.Zero ? Marshal.PtrToStringUni(nb, nl / 2) : (pid == 4 ? "System" : "");
                    string cmd = pid == 4 ? "" : CommandLine((int)pid);
                    if (!firstNew) neu.Append(',');
                    firstNew = false;
                    neu.Append('[').Append(pid).Append(',').Append(ppid).Append(',').Append(create).Append(',');
                    Esc(neu, name); neu.Append(','); Esc(neu, cmd); neu.Append(']');
                }
            }
            if (next == 0) break;
            off += next;
        }
        sb.Append("],\"n\":[").Append(neu).Append(']');
        if (sent.Count > seen.Count + 16)
        {
            var dead = new List<long>();
            foreach (long k in sent.Keys) if (!seen.Contains(k)) dead.Add(k);
            foreach (long k in dead) sent.Remove(k);
        }
        sb.Append(",\"g\":");
        if (gpu) sb.Append(GpuAsync()); else sb.Append("null");
        sb.Append('}');
        return sb.ToString();
    }

    // ---- GPU engine utilisation (\GPU Engine(*)\Utilization Percentage), diff-based ----
    static readonly Dictionary<string, CounterSample> gpuPrev = new Dictionary<string, CounterSample>();
    static readonly Dictionary<string, string[]> gpuMeta = new Dictionary<string, string[]>();
    static readonly Regex gpuRe = new Regex("^pid_(\\d+)_luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)_phys_(\\d+)_eng_(\\d+)_engtype_(.+)$", RegexOptions.Compiled);
    static bool gpuDead = false;
    static PerformanceCounterCategory gpuCat;

    static string gpuLast = "null";
    static bool gpuBusy = false;
    static readonly object gpuLock = new object();

    // The very first read of the GPU Engine category costs seconds; it runs on its own thread so process sampling never waits for it.
    static string GpuAsync()
    {
        lock (gpuLock)
        {
            if (!gpuBusy && !gpuDead)
            {
                gpuBusy = true;
                var t = new System.Threading.Thread(delegate ()
                {
                    string r = Gpu();
                    lock (gpuLock) { gpuLast = r; gpuBusy = false; }
                });
                t.IsBackground = true;
                t.Start();
            }
            return gpuDead ? "false" : gpuLast;
        }
    }

    static string Gpu()
    {
        if (gpuDead) return "false";
        try
        {
            if (gpuCat == null) gpuCat = new PerformanceCounterCategory("GPU Engine");
            var all = gpuCat.ReadCategory();
            if (!all.Contains("Utilization Percentage")) { gpuDead = true; return "false"; }
            var col = all["Utilization Percentage"];
            var cur = new Dictionary<string, CounterSample>();
            var perPid = new Dictionary<string, double>();
            var engines = new Dictionary<string, double>();
            bool have = gpuPrev.Count > 0;
            foreach (InstanceData d in col.Values)
            {
                string name = d.InstanceName;
                CounterSample cs = d.Sample;
                cur[name] = cs;
                CounterSample pv;
                if (!gpuPrev.TryGetValue(name, out pv)) continue;
                double v = CounterSample.Calculate(pv, cs);
                if (double.IsNaN(v) || v <= 0.04) continue;
                string[] m;
                if (!gpuMeta.TryGetValue(name, out m))
                {
                    Match x = gpuRe.Match(name);
                    m = x.Success ? new string[] { x.Groups[1].Value, x.Groups[2].Value + "|" + x.Groups[3].Value + "|" + x.Groups[4].Value + "|" + x.Groups[5].Value, x.Groups[5].Value } : null;
                    gpuMeta[name] = m;
                }
                if (m == null) continue;
                double a; string k = m[0] + "|" + m[2];
                perPid.TryGetValue(k, out a); perPid[k] = a + v;
                engines.TryGetValue(m[1], out a); engines[m[1]] = a + v;
            }
            gpuPrev.Clear();
            foreach (var kv in cur) gpuPrev[kv.Key] = kv.Value;
            if (!have) return "null";
            var best = new Dictionary<string, double>();
            foreach (var kv in perPid)
            {
                string pid = kv.Key.Substring(0, kv.Key.IndexOf('|'));
                double b; best.TryGetValue(pid, out b);
                if (kv.Value > b) best[pid] = kv.Value;
            }
            double total = 0;
            foreach (var kv in engines) if (kv.Value > total) total = kv.Value;
            var sb = new StringBuilder();
            sb.Append("{\"total\":").Append(Math.Min(100, total).ToString("0.0", inv)).Append(",\"p\":{");
            bool f = true;
            foreach (var kv in best)
            {
                if (!f) sb.Append(',');
                f = false;
                sb.Append('"').Append(kv.Key).Append("\":").Append(Math.Min(100, kv.Value).ToString("0.0", inv));
            }
            sb.Append("}}");
            return sb.ToString();
        }
        catch (Exception)
        {
            gpuDead = true;
            return "false";
        }
    }

    // ---- detail / actions ----
    static string UserOf(int pid)
    {
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) return null;
        try
        {
            IntPtr tok;
            if (!OpenProcessToken(h, 8, out tok)) return null;
            try
            {
                int len;
                GetTokenInformation(tok, 1, IntPtr.Zero, 0, out len);
                if (len <= 0) return null;
                IntPtr b = Marshal.AllocHGlobal(len);
                try
                {
                    if (!GetTokenInformation(tok, 1, b, len, out len)) return null;
                    var sid = new SecurityIdentifier(Marshal.ReadIntPtr(b, 0));
                    try { return sid.Translate(typeof(NTAccount)).Value; } catch (Exception) { return sid.Value; }
                }
                finally { Marshal.FreeHGlobal(b); }
            }
            finally { CloseHandle(tok); }
        }
        finally { CloseHandle(h); }
    }

    static string PathOf(int pid)
    {
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) return null;
        try
        {
            var sb = new StringBuilder(1024);
            int n = sb.Capacity;
            return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : null;
        }
        finally { CloseHandle(h); }
    }

    // Suspended = every thread is Waiting with WaitReason Suspended.
    static bool IsSuspended(int pid)
    {
        if (!Query()) return false;
        int off = 0;
        while (true)
        {
            IntPtr p = new IntPtr(buf.ToInt64() + off);
            int next = Marshal.ReadInt32(p, 0);
            if (Marshal.ReadIntPtr(p, 80).ToInt64() == pid)
            {
                int n = Marshal.ReadInt32(p, 4);
                if (n == 0) return false;
                for (int i = 0; i < n; i++)
                {
                    long t = p.ToInt64() + 256 + (long)i * 80;
                    int state = Marshal.ReadInt32(new IntPtr(t), 68);
                    int reason = Marshal.ReadInt32(new IntPtr(t), 72);
                    if (!(state == 5 && reason == 5)) return false;
                }
                return true;
            }
            if (next == 0) return false;
            off += next;
        }
    }

    static int PostClose(int pid)
    {
        int n = 0;
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            int wp;
            GetWindowThreadProcessId(h, out wp);
            if (wp == pid && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero) { PostMessage(h, 0x10, IntPtr.Zero, IntPtr.Zero); n++; }
            return true;
        }, IntPtr.Zero);
        return n;
    }

    static int Terminate(int pid)
    {
        IntPtr h = OpenProcess(0x0001, false, pid);
        if (h == IntPtr.Zero) return Marshal.GetLastWin32Error();
        try { return TerminateProcess(h, 1) ? 0 : Marshal.GetLastWin32Error(); }
        finally { CloseHandle(h); }
    }

    static int Suspend(int pid, bool resume)
    {
        IntPtr h = OpenProcess(0x0800, false, pid);
        if (h == IntPtr.Zero) return Marshal.GetLastWin32Error();
        try { int st = resume ? NtResumeProcess(h) : NtSuspendProcess(h); return st >= 0 ? 0 : st; }
        finally { CloseHandle(h); }
    }

    public static string Handle(string line)
    {
        try
        {
            string[] a = line.Trim().Split(' ');
            var sb = new StringBuilder();
            switch (a[0])
            {
                case "s": return Sample(a.Length > 1 && a[1] == "g");
                case "d":
                    {
                        int pid = int.Parse(a[1], inv);
                        sb.Append("{\"pid\":").Append(pid).Append(",\"user\":"); Esc(sb, UserOf(pid));
                        sb.Append(",\"path\":"); Esc(sb, PathOf(pid));
                        sb.Append(",\"suspended\":").Append(IsSuspended(pid) ? "true" : "false").Append('}');
                        return sb.ToString();
                    }
                case "x": return "{\"closed\":" + PostClose(int.Parse(a[1], inv)) + "}";
                case "k":
                    {
                        sb.Append("{\"results\":{");
                        bool f = true;
                        foreach (string s in a[1].Split(','))
                        {
                            int pid = int.Parse(s, inv);
                            if (!f) sb.Append(',');
                            f = false;
                            sb.Append('"').Append(pid).Append("\":").Append(Terminate(pid));
                        }
                        sb.Append("}}");
                        return sb.ToString();
                    }
                case "z": return "{\"code\":" + Suspend(int.Parse(a[1], inv), false) + "}";
                case "r": return "{\"code\":" + Suspend(int.Parse(a[1], inv), true) + "}";
                case "ping": return "{\"pong\":true}";
            }
            return "{\"error\":\"unknown command\"}";
        }
        catch (Exception e)
        {
            var sb = new StringBuilder("{\"error\":");
            Esc(sb, e.Message);
            sb.Append('}');
            return sb.ToString();
        }
    }
}
` }
