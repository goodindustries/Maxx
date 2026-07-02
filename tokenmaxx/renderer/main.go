// maxx statusline renderer — the LOOK, in Go + lipgloss.
// Reads Claude Code's stdin JSON + the ~/.tokenmaxx caches the node sidecars write
// (window.json = quota, state.json = brain advice / sprint / intent), then renders
// the 2.5-pane panel: Console │ Coach │ Events, with the M mark full-height.
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/charmbracelet/lipgloss"
	colorful "github.com/lucasb-eyer/go-colorful"
	"github.com/muesli/termenv"
)

// ─── palette (matches the python _hsl(270, …) so the brand is identical) ────────
func hueToRGB(m1, m2, hue float64) float64 {
	hue = math.Mod(hue, 1)
	if hue < 0 {
		hue++
	}
	switch {
	case hue < 1.0/6:
		return m1 + (m2-m1)*hue*6
	case hue < 0.5:
		return m2
	case hue < 2.0/3:
		return m1 + (m2-m1)*(2.0/3-hue)*6
	default:
		return m1
	}
}

func hsl(h, s, l float64) lipgloss.Color {
	hh := h / 360
	var r, g, b float64
	if s == 0 {
		r, g, b = l, l, l
	} else {
		var m2 float64
		if l <= 0.5 {
			m2 = l * (1 + s)
		} else {
			m2 = l + s - l*s
		}
		m1 := 2*l - m2
		r = hueToRGB(m1, m2, hh+1.0/3)
		g = hueToRGB(m1, m2, hh)
		b = hueToRGB(m1, m2, hh-1.0/3)
	}
	return lipgloss.Color(fmt.Sprintf("#%02x%02x%02x",
		int(math.Round(r*255)), int(math.Round(g*255)), int(math.Round(b*255))))
}

var (
	BRAND = hsl(270, 0.58, 0.52)
	INK   = hsl(270, 0.48, 0.30)
	DIM   = hsl(270, 0.30, 0.50)
	TRACK = hsl(270, 0.35, 0.80)
	BG    = hsl(270, 0.55, 0.88)
	GREEN = lipgloss.Color("#2fa84a")
	AMBER = lipgloss.Color("#d69e2e")
	RED   = lipgloss.Color("#e0433c")
)

// fg renders text in a color on the panel background (so the band stays unbroken).
func fg(c lipgloss.Color, s string) string {
	return lipgloss.NewStyle().Foreground(c).Background(BG).Render(s)
}

// shade nudges a color's lightness (±) for gradients / sheen.
func shade(c lipgloss.Color, dl float64) lipgloss.Color {
	cc, err := colorful.Hex(string(c))
	if err != nil {
		return c
	}
	h, s, l := cc.Hsl()
	l = math.Max(0, math.Min(1, l+dl))
	return lipgloss.Color(colorful.Hsl(h, s, l).Hex())
}

// mMark: the beveled M — each block gets a top-lit vertical ramp plus a shine that
// sweeps diagonally with `phase` (time-driven), so it reads as tiled 2.5D depth.
var mPattern = []string{"█   █", "██ ██", "█ █ █", "█   █", "█   █"}

func mMarkRows(phase float64) []string {
	out := make([]string, 5)
	for r := 0; r < 5; r++ {
		var b strings.Builder
		for c, ch := range mPattern[r] {
			if ch != '█' {
				b.WriteString(fg(BG, " "))
				continue
			}
			base := 0.62 - 0.22*(float64(r)/4.0) // top lighter, bottom darker
			shine := math.Max(0, 1-math.Abs((float64(c)-float64(r))-phase)/1.8)
			l := math.Min(0.97, base+0.26*shine)
			b.WriteString(fg(hsl(270, 0.55, l), "█"))
		}
		out[r] = b.String()
	}
	return out
}

// spawn the (heavy) quota scan in the background when its cache is stale.
func maybeSpawnScans() {
	win := filepath.Join(home(), ".tokenmaxx", "window.json")
	if fi, err := os.Stat(win); err == nil && time.Since(fi.ModTime()) < 120*time.Second {
		return
	}
	limit := filepath.Join(home(), ".claude", "skills", "maxx", "limit.mjs")
	if _, err := os.Stat(limit); err != nil {
		return
	}
	cmd := exec.Command("node", limit)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	_ = cmd.Start()
}

// ─── inputs ─────────────────────────────────────────────────────────────────────
type Payload struct {
	TranscriptPath string `json:"transcript_path"`
	Model          struct {
		DisplayName string `json:"display_name"`
		ID          string `json:"id"`
	} `json:"model"`
	Workspace struct {
		ProjectDir string `json:"project_dir"`
		CurrentDir string `json:"current_dir"`
	} `json:"workspace"`
	Cost struct {
		TotalCostUSD    float64 `json:"total_cost_usd"`
		TotalDurationMs float64 `json:"total_duration_ms"`
	} `json:"cost"`
	ContextWindow struct {
		Size         float64 `json:"context_window_size"`
		UsedPct      float64 `json:"used_percentage"`
		CurrentUsage struct {
			InputTokens   float64 `json:"input_tokens"`
			CacheRead     float64 `json:"cache_read_input_tokens"`
			CacheCreation float64 `json:"cache_creation_input_tokens"`
		} `json:"current_usage"`
	} `json:"context_window"`
}

func home() string { h, _ := os.UserHomeDir(); return h }

func readJSON(path string, v any) bool {
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return json.Unmarshal(b, v) == nil
}

func readState() map[string]any {
	m := map[string]any{}
	readJSON(filepath.Join(home(), ".tokenmaxx", "state.json"), &m)
	return m
}

func writeState(m map[string]any) {
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	os.WriteFile(filepath.Join(home(), ".tokenmaxx", "state.json"), b, 0o644)
}

func sf(m map[string]any, k string) float64 {
	if v, ok := m[k].(float64); ok {
		return v
	}
	return 0
}
func ss(m map[string]any, k string) string {
	if v, ok := m[k].(string); ok {
		return v
	}
	return ""
}

// micro-sprint countdown (mins left); a >5min idle gap starts a fresh sprint.
func sprintTimer(st map[string]any) int {
	now := float64(time.Now().Unix())
	last, start := sf(st, "sess_last"), sf(st, "sess_start")
	if start == 0 || now-last > 300 {
		start = now
	}
	st["sess_start"], st["sess_last"] = start, now
	return int(math.Round(30 - (now-start)/60))
}

// git branch from .git/HEAD, walking up from the project dir.
func gitBranch(dir string) string {
	for d := dir; d != "" && d != "/"; d = filepath.Dir(d) {
		if b, err := os.ReadFile(filepath.Join(d, ".git", "HEAD")); err == nil {
			s := strings.TrimSpace(string(b))
			if strings.HasPrefix(s, "ref: refs/heads/") {
				return strings.TrimPrefix(s, "ref: refs/heads/")
			}
			if len(s) >= 7 {
				return s[:7]
			}
			return ""
		}
	}
	return ""
}

func modelFamily(name string) string {
	l := strings.ToLower(name)
	switch {
	case strings.Contains(l, "opus"):
		return "Opus"
	case strings.Contains(l, "haiku"):
		return "Haiku"
	case strings.Contains(l, "sonnet"):
		return "Sonnet"
	}
	if len(name) > 8 {
		return name[:8]
	}
	return name
}

// horizontal gauge bar: filled cells in `col`, track in TRACK, on the panel bg.
func bar(frac float64, width int, col lipgloss.Color) string {
	if frac < 0 {
		frac = 0
	}
	if frac > 1 {
		frac = 1
	}
	fl := int(math.Round(frac * float64(width)))
	var b strings.Builder
	for i := 0; i < fl; i++ { // dark→light sheen across the fill
		t := 0.0
		if fl > 1 {
			t = float64(i) / float64(fl-1)
		}
		b.WriteString(fg(shade(col, -0.10+0.18*t), "█"))
	}
	b.WriteString(fg(TRACK, strings.Repeat("░", width-fl)))
	return b.String()
}

func trunc(s string, w int) string {
	r := []rune(s)
	if len(r) <= w {
		return s
	}
	if w < 1 {
		return "…"
	}
	return string(r[:w-1]) + "…"
}

func main() {
	lipgloss.SetColorProfile(termenv.TrueColor)
	maybeSpawnScans() // keep the quota cache fresh

	var p Payload
	json.NewDecoder(os.Stdin).Decode(&p)

	cols := 130
	if c := os.Getenv("COLUMNS"); c != "" {
		fmt.Sscanf(c, "%d", &cols)
	}

	// ── read the sidecar caches ──
	st := readState()
	var win struct {
		Pct       *float64 `json:"pct"`
		MinsToCap *float64 `json:"minsToCap"`
	}
	readJSON(filepath.Join(home(), ".tokenmaxx", "window.json"), &win)

	// ── compute display values ──
	ctxPct := p.ContextWindow.UsedPct
	cu := p.ContextWindow.CurrentUsage
	total := cu.InputTokens + cu.CacheRead + cu.CacheCreation
	cache := 0.0
	if total > 0 {
		cache = cu.CacheRead / total
	}
	quota, haveQuota := 0.0, win.Pct != nil
	if haveQuota {
		quota = *win.Pct
	}
	usd := p.Cost.TotalCostUSD
	fam := modelFamily(p.Model.DisplayName)
	branch := gitBranch(p.Workspace.ProjectDir)
	left := sprintTimer(st)
	writeState(st)

	// quota color — the vibe coder's wall, the only red
	qcol := GREEN
	switch {
	case quota >= 0.9:
		qcol = RED
	case quota >= 0.75:
		qcol = AMBER
	}
	// temp = how hot you're running (cache efficiency)
	tword, tcol := "cool", GREEN
	switch {
	case cache < 0.6:
		tword, tcol = "hot", RED
	case cache < 0.85:
		tword, tcol = "warm", AMBER
	}
	// health dot: quota first, then temp; context never reds it
	hcol := GREEN
	switch {
	case quota >= 0.9:
		hcol = RED
	case quota >= 0.75 || cache < 0.6:
		hcol = AMBER
	}

	// narrow terminal: one compact line, no panes (avoids a broken 3-column layout)
	if cols < 88 {
		l := fg(hcol, "●")
		if haveQuota {
			l += " " + bar(quota, 5, qcol) + fg(qcol, fmt.Sprintf(" %d%%", int(quota*100)))
		}
		l += fg(DIM, "  ") + fg(tcol, tword)
		ct, cc := coachLine(st, cache, ctxPct)
		l += fg(DIM, "  ") + fg(cc, trunc(ct, cols-22))
		fmt.Println(lipgloss.NewStyle().Background(BG).Render(l))
		return
	}

	// ── pane widths ──
	inner := cols - 4
	mW := 6
	avail := inner - mW - 2 // M + two separators
	cw := avail * 40 / 100
	hw := avail * 36 / 100
	ew := avail - cw - hw

	// ── CONSOLE pane ──
	qLine := fg(hcol, "●") + fg(DIM, " quota ")
	if haveQuota {
		qLine += bar(quota, 8, qcol) + fg(qcol, fmt.Sprintf(" %d%%", int(quota*100)))
	} else {
		qLine += fg(DIM, "—")
	}
	tLine := fg(DIM, "temp ") + fg(tcol, tword) + fg(DIM, fmt.Sprintf("  %d%%", int(cache*100)))
	mdLine := fg(DIM, fam)
	if branch != "" {
		mdLine += fg(DIM, "  "+branch)
	}
	scol := GREEN
	if left <= 5 {
		scol = AMBER
	}
	if left <= 0 {
		scol = RED
	}
	sTxt := fmt.Sprintf("%dm", left)
	if left <= 0 {
		sTxt = "break?"
	}
	sLine := fg(DIM, "sprint ") + fg(scol, sTxt)
	cLine := fg(DIM, "$") + fg(INK, fmt.Sprintf("%.0f", usd)) + fg(DIM, fmt.Sprintf("  ctx %d%%", int(ctxPct)))
	console := strings.Join([]string{qLine, tLine, mdLine, sLine, cLine}, "\n")

	// ── COACH pane (lipgloss wraps to width) ──
	ctext, ccol := coachLine(st, cache, ctxPct)
	coachBody := lipgloss.NewStyle().Width(hw).Background(BG).Foreground(ccol).Render(ctext)
	coachBlock := fg(DIM, "coach") + "\n" + coachBody

	// ── EVENTS pane (the .5) ──
	items := events(st)
	evLines := []string{fg(DIM, "events")}
	for i := 0; i < 4 && i < len(items); i++ {
		evLines = append(evLines, fg(INK, trunc("▸ "+items[i], ew)))
	}
	eventsBlock := strings.Join(evLines, "\n")

	// ── assemble panes + separators + M ──
	pane := func(w int) lipgloss.Style {
		return lipgloss.NewStyle().Width(w).Height(5).Background(BG)
	}
	sep := pane(1).Foreground(DIM).Render(strings.Repeat("│\n", 4) + "│")
	phase := float64(time.Now().Unix()%8) - 4 // shine sweep, advances each tick
	mBlock := pane(mW).Align(lipgloss.Right).Render(strings.Join(mMarkRows(phase), "\n"))

	row := lipgloss.JoinHorizontal(lipgloss.Top,
		pane(cw).Render(console), sep,
		pane(hw).Render(coachBlock), sep,
		pane(ew).Render(eventsBlock), mBlock,
	)

	panel := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(hsl(270, 0.5, 0.42)).
		BorderBackground(BG).
		Background(BG).
		Padding(0, 1).
		Render(row)

	fmt.Println(panel)
}

// coachLine: brain advice (fresh) > sprint intention > temp nudge > clean.
func coachLine(st map[string]any, cache, ctxPct float64) (string, lipgloss.Color) {
	adv, advTs := ss(st, "advice"), sf(st, "advice_ts")
	if adv != "" && float64(time.Now().Unix())-advTs < 300 {
		return adv, AMBER
	}
	intent, intentStart, sess := ss(st, "intent"), sf(st, "intent_start"), sf(st, "sess_start")
	if intent != "" && math.Abs(intentStart-sess) < 1 {
		return "→ " + intent, BRAND
	}
	now := float64(time.Now().Unix())
	if now-sess > 0 && now-sess < 180 && intent == "" {
		return "new sprint — set your intention", AMBER
	}
	if cache < 0.6 {
		return "warm cache reads ~10× cheaper; avoid 5-min idle gaps", AMBER
	}
	return "running clean — nothing to fix", GREEN
}

// events: the discovery cache the node sidecar writes, else a sensible default.
func events(st map[string]any) []string {
	var disc []struct {
		Title string `json:"title"`
		Pts   int    `json:"points"`
	}
	if readJSON(filepath.Join(home(), ".tokenmaxx", "discovery.json"), &disc) && len(disc) > 0 {
		out := make([]string, 0, len(disc))
		for _, d := range disc {
			if d.Pts > 0 {
				out = append(out, fmt.Sprintf("%s · %dpts", d.Title, d.Pts))
			} else {
				out = append(out, d.Title)
			}
		}
		return out
	}
	return []string{
		"PeerTube v7 ships · 412pts",
		"FFmpeg 9.1 AAC encoder · 294pts",
		"Show HN: maxx · 188pts",
		"Bevy 0.15 released · 233pts",
	}
}
