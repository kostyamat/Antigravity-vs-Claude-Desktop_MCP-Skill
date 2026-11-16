/* quota-alert for Windows: one window in the middle of the screen, above everything,
 * with a red headline and a few lines of text, until somebody closes it.
 *
 *   quota-alert.exe <text file, UTF-8> [seconds]
 *
 * The first line of the file is the headline, the rest is the body. With `seconds`
 * the window closes by itself after that long (used by the test); without, it stays.
 *
 * Why a program of its own: a Windows notification is shown for a few seconds in a
 * corner, is swallowed by Focus Assist and by a full-screen window, and leaves no
 * trace when it was missed. A quota that is about to run out stops every agent on the
 * machine; the owner must not be able to miss it.
 *
 * Build (MinGW): see build.sh. Plain Win32, no runtime to install.
 */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <shellapi.h>
#include <stdlib.h>

#define ID_OK 1
#define ID_TIMER 2

static wchar_t *g_head = L"";
static wchar_t *g_body = L"";
static HFONT g_fontHead, g_fontBody, g_fontBtn;
static int g_dpi = 96;

static int px(int v) { return MulDiv(v, g_dpi, 96); }

/* The whole file as wide text, or NULL. */
static wchar_t *read_utf8(const wchar_t *path) {
    HANDLE f = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (f == INVALID_HANDLE_VALUE) return NULL;
    DWORD size = GetFileSize(f, NULL), got = 0;
    if (size == INVALID_FILE_SIZE || size > 64 * 1024) { CloseHandle(f); return NULL; }
    char *raw = (char *)malloc(size + 1);
    if (!raw || !ReadFile(f, raw, size, &got, NULL)) { CloseHandle(f); return NULL; }
    CloseHandle(f);
    raw[got] = 0;
    char *s = raw;
    if (got >= 3 && (unsigned char)s[0] == 0xEF && (unsigned char)s[1] == 0xBB && (unsigned char)s[2] == 0xBF) s += 3;
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    wchar_t *w = (wchar_t *)malloc(sizeof(wchar_t) * (n + 1));
    if (!w) return NULL;
    MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n);
    free(raw);
    return w;
}

static LRESULT CALLBACK proc(HWND h, UINT m, WPARAM wp, LPARAM lp) {
    switch (m) {
    case WM_CREATE: {
        RECT rc;
        GetClientRect(h, &rc);
        HWND b = CreateWindowW(L"BUTTON", L"OK", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
                               rc.right - px(160), rc.bottom - px(64), px(130), px(42), h, (HMENU)ID_OK,
                               ((LPCREATESTRUCT)lp)->hInstance, NULL);
        SendMessageW(b, WM_SETFONT, (WPARAM)g_fontBtn, TRUE);
        SetFocus(b);
        return 0;
    }
    case WM_COMMAND:
        if (LOWORD(wp) == ID_OK || LOWORD(wp) == IDCANCEL) DestroyWindow(h);
        return 0;
    case WM_TIMER:
        if (wp == ID_TIMER) DestroyWindow(h);
        return 0;
    case WM_KEYDOWN:
        if (wp == VK_ESCAPE || wp == VK_RETURN) DestroyWindow(h);
        return 0;
    case WM_ERASEBKGND:
        return 1;
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        RECT rc, band, text;
        GetClientRect(h, &rc);
        HBRUSH white = CreateSolidBrush(RGB(255, 255, 255));
        HBRUSH red = CreateSolidBrush(RGB(200, 16, 16));
        FillRect(dc, &rc, white);
        band = rc; band.bottom = px(12);
        FillRect(dc, &band, red);
        SetBkMode(dc, TRANSPARENT);

        text.left = px(32); text.right = rc.right - px(32); text.top = px(34); text.bottom = rc.bottom;
        SelectObject(dc, g_fontHead);
        SetTextColor(dc, RGB(200, 16, 16));
        int hh = DrawTextW(dc, g_head, -1, &text, DT_WORDBREAK | DT_NOPREFIX);

        text.top += hh + px(18); text.bottom = rc.bottom - px(76);
        SelectObject(dc, g_fontBody);
        SetTextColor(dc, RGB(24, 24, 24));
        DrawTextW(dc, g_body, -1, &text, DT_WORDBREAK | DT_NOPREFIX);

        DeleteObject(white);
        DeleteObject(red);
        EndPaint(h, &ps);
        return 0;
    }
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(h, m, wp, lp);
}

static HFONT font(int size, int weight) {
    return CreateFontW(-px(size), 0, 0, 0, weight, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                       CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR cmd, int show) {
    (void)prev; (void)cmd; (void)show;
    int argc = 0;
    wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv || argc < 2) return 2;
    wchar_t *all = read_utf8(argv[1]);
    if (!all) return 3;
    int seconds = argc > 2 ? _wtoi(argv[2]) : 0;

    /* First line: the headline. The rest: the body, line ends as written. */
    g_head = all;
    wchar_t *nl = all;
    while (*nl && *nl != L'\n' && *nl != L'\r') nl++;
    if (*nl) {
        *nl++ = 0;
        while (*nl == L'\n' || *nl == L'\r') nl++;
        g_body = nl;
    }

    SetProcessDPIAware();
    HDC screen = GetDC(NULL);
    g_dpi = GetDeviceCaps(screen, LOGPIXELSX);
    ReleaseDC(NULL, screen);
    g_fontHead = font(34, FW_BOLD);
    g_fontBody = font(19, FW_NORMAL);
    g_fontBtn = font(16, FW_SEMIBOLD);

    WNDCLASSW wc = {0};
    wc.lpfnWndProc = proc;
    wc.hInstance = inst;
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    wc.hIcon = LoadIcon(NULL, IDI_WARNING);
    wc.lpszClassName = L"AgentBridgeQuotaAlert";
    RegisterClassW(&wc);

    /* As tall as the text needs: a warning cut off at the bottom of the window is one
     * the owner cannot read. Measured with the fonts it will be drawn in. */
    DWORD style = WS_POPUP | WS_CAPTION | WS_SYSMENU, ex = WS_EX_TOPMOST | WS_EX_APPWINDOW;
    int cw = px(820), ch;
    HDC mdc = CreateCompatibleDC(NULL);
    RECT mh = { 0, 0, cw - 2 * px(32), 0 }, mb = mh;
    SelectObject(mdc, g_fontHead);
    DrawTextW(mdc, g_head, -1, &mh, DT_WORDBREAK | DT_NOPREFIX | DT_CALCRECT);
    SelectObject(mdc, g_fontBody);
    DrawTextW(mdc, g_body, -1, &mb, DT_WORDBREAK | DT_NOPREFIX | DT_CALCRECT);
    DeleteDC(mdc);
    ch = px(34) + mh.bottom + px(18) + mb.bottom + px(24) + px(76);
    int maxh = GetSystemMetrics(SM_CYSCREEN) * 85 / 100;
    if (ch < px(280)) ch = px(280);
    RECT wr = { 0, 0, cw, ch };
    AdjustWindowRectEx(&wr, style, FALSE, ex);
    int w = wr.right - wr.left, hgt = wr.bottom - wr.top;
    if (hgt > maxh) hgt = maxh;
    int x = (GetSystemMetrics(SM_CXSCREEN) - w) / 2, y = (GetSystemMetrics(SM_CYSCREEN) - hgt) / 3;
    HWND h = CreateWindowExW(ex, wc.lpszClassName, g_head, style, x, y, w, hgt, NULL, NULL, inst, NULL);
    if (!h) return 4;
    ShowWindow(h, SW_SHOWNORMAL);
    SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    SetForegroundWindow(h);
    MessageBeep(MB_ICONWARNING);
    FLASHWINFO fl = { sizeof(fl), h, FLASHW_ALL | FLASHW_TIMERNOFG, 0, 0 };
    FlashWindowEx(&fl);
    if (seconds > 0) SetTimer(h, ID_TIMER, (UINT)seconds * 1000, NULL);

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        if (msg.message == WM_KEYDOWN && (msg.wParam == VK_ESCAPE || msg.wParam == VK_RETURN)) { DestroyWindow(h); continue; }
        if (IsDialogMessageW(h, &msg)) continue;
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return 0;
}
