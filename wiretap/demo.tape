# Records wiretap-demo.gif with vhs (https://github.com/charmbracelet/vhs).
# Run from this directory: vhs < demo.tape
# Sleeps assume a fast provider reply — tune "Sleep 20s" to your model.
# On Windows, vhs needs WSL; alternatively record Windows Terminal with
# ScreenToGif or asciinema.
Output wiretap-demo.gif
Set Width 1200
Set Height 700
Set FontSize 16
Set Theme "Catppuccin Mocha"

# Start omp with the extension loaded from this checkout
Type "omp --no-title -e ."
Enter
Sleep 4s

# Generate one real provider request
Type "Reply with exactly: ok"
Enter
Sleep 20s

# The capture list
Type "/wire"
Enter
Sleep 2s

# Full detail: endpoint, status, headers, highlighted body
Type "/wire 1"
Enter
Sleep 3s
