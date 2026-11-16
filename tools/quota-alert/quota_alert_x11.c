/* quota-alert for Linux (X11, also under XWayland): one window in the middle of the
 * screen, kept above the others, with a red headline and a few lines of text, until
 * somebody closes it.
 *
 *   quota-alert <text file, UTF-8> [seconds]
 *
 * The first line of the file is the headline, the rest is the body. With `seconds`
 * the window closes by itself after that long (used by the test); without, it stays.
 * Closed by the OK button, Enter, Escape or the window's own close button.
 *
 * Build: see build.sh (Xlib + Xft, both present on any desktop Linux).
 */
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/Xatom.h>
#include <X11/keysym.h>
#include <X11/Xft/Xft.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <time.h>

#define W 820
static int H = 400;                      /* set from the text before the window is made */
#define PAD 32
#define BTN_W 130
#define BTN_H 42

static Display *dpy;
static Window win;
static XftDraw *draw;
static XftFont *fHead, *fBody, *fBtn;
static XftColor cRed, cInk, cWhite, cBtn;
static char *head = "", *body = "";

static char *read_file(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    char *buf = malloc(64 * 1024 + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t n = fread(buf, 1, 64 * 1024, f);
    fclose(f);
    buf[n] = 0;
    if (n >= 3 && (unsigned char)buf[0] == 0xEF && (unsigned char)buf[1] == 0xBB && (unsigned char)buf[2] == 0xBF) return buf + 3;
    return buf;
}

static int width_of(XftFont *font, const char *s, int len) {
    XGlyphInfo e;
    XftTextExtentsUtf8(dpy, font, (const FcChar8 *)s, len, &e);
    return e.xOff;
}

/* Draw text wrapped at word breaks inside `maxw`; returns the y below the last line.
 * A line that would cross `maxy` is not drawn. */
static int wrapped(XftFont *font, XftColor *color, const char *text, int x, int y, int maxw, int maxy, int paint_it) {
    int lineh = font->ascent + font->descent + 4;
    const char *p = text;
    while (*p) {
        const char *eol = strchr(p, '\n');
        if (!eol) eol = p + strlen(p);
        const char *s = p;
        if (s == eol) y += lineh / 2;                       /* an empty line is half a line */
        while (s < eol) {
            const char *fit = s, *q = s;
            while (q < eol) {                               /* the longest run of words that fits */
                const char *sp = memchr(q, ' ', (size_t)(eol - q));
                const char *end = sp ? sp : eol;
                if (width_of(font, s, (int)(end - s)) > maxw && fit > s) break;
                fit = end;
                q = sp ? sp + 1 : eol;
            }
            if (fit == s) fit = eol;
            if (paint_it && y + lineh <= maxy) XftDrawStringUtf8(draw, color, font, x, y + font->ascent, (const FcChar8 *)s, (int)(fit - s));
            y += lineh;
            s = fit;
            while (s < eol && *s == ' ') s++;
        }
        p = *eol ? eol + 1 : eol;
    }
    return y;
}

static void paint(void) {
    XftDrawRect(draw, &cWhite, 0, 0, W, H);
    XftDrawRect(draw, &cRed, 0, 0, W, 12);
    int y = wrapped(fHead, &cRed, head, PAD, 34, W - 2 * PAD, H, 1);
    wrapped(fBody, &cInk, body, PAD, y + 18, W - 2 * PAD, H - 76, 1);
    int bx = W - PAD - BTN_W, by = H - 22 - BTN_H;
    XftDrawRect(draw, &cBtn, bx, by, BTN_W, BTN_H);
    int tw = width_of(fBtn, "OK", 2);
    XftDrawStringUtf8(draw, &cWhite, fBtn, bx + (BTN_W - tw) / 2, by + (BTN_H + fBtn->ascent - fBtn->descent) / 2, (const FcChar8 *)"OK", 2);
}

static void color(XftColor *c, unsigned short r, unsigned short g, unsigned short b) {
    XRenderColor rc = { (unsigned short)(r * 257), (unsigned short)(g * 257), (unsigned short)(b * 257), 0xffff };
    XftColorAllocValue(dpy, DefaultVisual(dpy, DefaultScreen(dpy)), DefaultColormap(dpy, DefaultScreen(dpy)), &rc, c);
}

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    char *all = read_file(argv[1]);
    if (!all) return 3;
    int seconds = argc > 2 ? atoi(argv[2]) : 0;
    head = all;
    char *nl = strpbrk(all, "\r\n");
    if (nl) {
        *nl++ = 0;
        while (*nl == '\n' || *nl == '\r') nl++;
        body = nl;
        for (char *c = body; *c; c++) if (*c == '\r') *c = ' ';
    }

    dpy = XOpenDisplay(NULL);
    if (!dpy) return 5;
    int scr = DefaultScreen(dpy);
    fHead = XftFontOpenName(dpy, scr, "sans:bold:pixelsize=34");
    fBody = XftFontOpenName(dpy, scr, "sans:pixelsize=19");
    fBtn = XftFontOpenName(dpy, scr, "sans:bold:pixelsize=16");
    if (!fHead || !fBody || !fBtn) return 6;
    /* As tall as the text needs, measured with the fonts it will be drawn in. */
    int need = wrapped(fHead, NULL, head, PAD, 34, W - 2 * PAD, 1 << 20, 0);
    need = wrapped(fBody, NULL, body, PAD, need + 18, W - 2 * PAD, 1 << 20, 0) + 24 + 76;
    H = need < 280 ? 280 : need;
    if (H > DisplayHeight(dpy, scr) * 85 / 100) H = DisplayHeight(dpy, scr) * 85 / 100;
    int x = (DisplayWidth(dpy, scr) - W) / 2, y = (DisplayHeight(dpy, scr) - H) / 3;
    win = XCreateSimpleWindow(dpy, RootWindow(dpy, scr), x, y, W, H, 0, 0, WhitePixel(dpy, scr));

    XSizeHints *sh = XAllocSizeHints();
    sh->flags = PPosition | PSize | PMinSize | PMaxSize;
    sh->x = x; sh->y = y; sh->width = sh->min_width = sh->max_width = W; sh->height = sh->min_height = sh->max_height = H;
    XSetWMNormalHints(dpy, win, sh);
    Atom utf8 = XInternAtom(dpy, "UTF8_STRING", False);
    XChangeProperty(dpy, win, XInternAtom(dpy, "_NET_WM_NAME", False), utf8, 8, PropModeReplace, (unsigned char *)head, (int)strlen(head));
    XStoreName(dpy, win, "Quota alert");
    Atom above = XInternAtom(dpy, "_NET_WM_STATE_ABOVE", False);
    Atom state = XInternAtom(dpy, "_NET_WM_STATE", False);
    XChangeProperty(dpy, win, state, XA_ATOM, 32, PropModeReplace, (unsigned char *)&above, 1);
    Atom dialog = XInternAtom(dpy, "_NET_WM_WINDOW_TYPE_DIALOG", False);
    XChangeProperty(dpy, win, XInternAtom(dpy, "_NET_WM_WINDOW_TYPE", False), XA_ATOM, 32, PropModeReplace, (unsigned char *)&dialog, 1);
    Atom wmDelete = XInternAtom(dpy, "WM_DELETE_WINDOW", False);
    XSetWMProtocols(dpy, win, &wmDelete, 1);

    color(&cRed, 200, 16, 16); color(&cInk, 24, 24, 24); color(&cWhite, 255, 255, 255); color(&cBtn, 60, 60, 60);
    draw = XftDrawCreate(dpy, win, DefaultVisual(dpy, scr), DefaultColormap(dpy, scr));

    XSelectInput(dpy, win, ExposureMask | KeyPressMask | ButtonPressMask | StructureNotifyMask);
    XMapRaised(dpy, win);
    XBell(dpy, 100);
    XFlush(dpy);

    time_t until = seconds > 0 ? time(NULL) + seconds : 0;
    int fd = ConnectionNumber(dpy);
    for (;;) {
        while (XPending(dpy)) {
            XEvent e;
            XNextEvent(dpy, &e);
            if (e.type == Expose && e.xexpose.count == 0) paint();
            else if (e.type == KeyPress) {
                KeySym k = XLookupKeysym(&e.xkey, 0);
                if (k == XK_Escape || k == XK_Return || k == XK_KP_Enter) return 0;
            } else if (e.type == ButtonPress) {
                int bx = W - PAD - BTN_W, by = H - 22 - BTN_H;
                if (e.xbutton.x >= bx && e.xbutton.x <= bx + BTN_W && e.xbutton.y >= by && e.xbutton.y <= by + BTN_H) return 0;
            } else if (e.type == ClientMessage && (Atom)e.xclient.data.l[0] == wmDelete) return 0;
            else if (e.type == DestroyNotify) return 0;
        }
        if (until && time(NULL) >= until) return 0;
        fd_set r;
        FD_ZERO(&r);
        FD_SET(fd, &r);
        struct timeval tv = { 1, 0 };
        select(fd + 1, &r, NULL, NULL, &tv);
    }
}
