//go:build windows

// NoStream.exe — avvio della versione portable per Windows.
//
// Struttura della cartella:
//
//	NoStream\NoStream.exe        questo programma
//	NoStream\config.json         impostazioni (creato al primo avvio)
//	NoStream\data\               file sul server, video da link, aggiornamenti, log
//	NoStream\app\                Node, NoStream, ffmpeg e yt-dlp (app\bin)
//
// Avvia il server con tutti i percorsi dentro la cartella, apre il browser quando è
// pronto e resta aperto finché NoStream è attivo: chiudendo la finestra si ferma.
// Se NoStream è già attivo apre solo il browser.
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const defaultPort = 4321

func main() {
	exe, err := os.Executable()
	if err != nil {
		fail("Impossibile trovare la cartella di NoStream: %v", err)
	}
	root := filepath.Dir(exe)
	setTitle("NoStream")

	port := readPort(filepath.Join(root, "config.json"))
	url := fmt.Sprintf("http://localhost:%d", port)
	openBrowser := !hasArg("--no-browser")

	// Già attivo (es. doppio clic una seconda volta): basta aprire il browser.
	if isNoStream(port) {
		fmt.Printf("NoStream è già attivo su %s\n", url)
		if openBrowser {
			browse(url)
		}
		time.Sleep(2 * time.Second)
		return
	}
	if portBusy(port) {
		fail("La porta %d è già usata da un altro programma.\nCambia \"port\" in config.json oppure chiudi l'altro programma.", port)
	}

	app := filepath.Join(root, "app")
	node := filepath.Join(app, "node", "node.exe")
	if _, err := os.Stat(node); err != nil {
		fail("Manca %s: la cartella di NoStream non è completa. Scarica di nuovo lo zip.", node)
	}
	data := filepath.Join(root, "data")
	logs := filepath.Join(data, "logs")
	if err := os.MkdirAll(logs, 0o755); err != nil {
		fail("Non riesco a creare %s: %v\nSposta la cartella di NoStream in un posto dove puoi scrivere (es. Documenti o Desktop).", data, err)
	}

	logPath := filepath.Join(logs, "nostream.log")
	if st, err := os.Stat(logPath); err == nil && st.Size() > 10<<20 {
		_ = os.Rename(logPath, logPath+".1")
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		fail("Non riesco a scrivere il log in %s: %v", logPath, err)
	}
	defer logFile.Close()

	cmd := exec.Command(node, filepath.Join(app, "server.js"))
	cmd.Dir = app
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Env = append(os.Environ(),
		"CONFIG_PATH="+filepath.Join(root, "config.json"),
		"DATA_DIR="+data,
		"NOSTREAM_PORTABLE=1",
		"PATH="+filepath.Join(app, "bin")+string(os.PathListSeparator)+os.Getenv("PATH"),
	)
	if err := cmd.Start(); err != nil {
		fail("Avvio di NoStream non riuscito: %v", err)
	}

	fmt.Println("NoStream si sta avviando…")
	go func() {
		for i := 0; i < 120; i++ {
			if isNoStream(port) {
				fmt.Println()
				fmt.Printf("  NoStream è attivo: %s\n", url)
				fmt.Println()
				fmt.Println("  Lascia aperta questa finestra: chiudendola NoStream si ferma.")
				fmt.Printf("  Log: %s\n", logPath)
				if openBrowser {
					browse(url)
				}
				return
			}
			time.Sleep(500 * time.Millisecond)
		}
		fmt.Printf("NoStream non risponde dopo un minuto: guarda il log in %s\n", logPath)
	}()

	if err := cmd.Wait(); err != nil {
		fail("NoStream si è fermato (%v).\nI dettagli sono nel log: %s", err, logPath)
	}
}

func hasArg(a string) bool {
	for _, x := range os.Args[1:] {
		if strings.EqualFold(x, a) {
			return true
		}
	}
	return false
}

func readPort(path string) int {
	b, err := os.ReadFile(path)
	if err != nil {
		return defaultPort
	}
	var c struct {
		Port int `json:"port"`
	}
	if json.Unmarshal(b, &c) != nil || c.Port <= 0 || c.Port > 65535 {
		return defaultPort
	}
	return c.Port
}

// isNoStream: sulla porta risponde proprio NoStream (non un altro programma).
func isNoStream(port int) bool {
	client := http.Client{Timeout: time.Second}
	res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/settings", port))
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var s struct {
		Version string `json:"version"`
	}
	return res.StatusCode == 200 && json.NewDecoder(res.Body).Decode(&s) == nil && s.Version != ""
}

func portBusy(port int) bool {
	l, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return true
	}
	l.Close()
	return false
}

func browse(url string) {
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

func setTitle(title string) {
	kernel32, err := syscall.LoadDLL("kernel32.dll")
	if err != nil {
		return
	}
	proc, err := kernel32.FindProc("SetConsoleTitleW")
	if err != nil {
		return
	}
	p, _ := syscall.UTF16PtrFromString(title)
	_, _, _ = proc.Call(uintptr(unsafe.Pointer(p)))
}

func fail(format string, a ...any) {
	fmt.Println()
	fmt.Printf(format+"\n", a...)
	fmt.Println()
	fmt.Println("Premi Invio per chiudere.")
	fmt.Scanln()
	os.Exit(1)
}
