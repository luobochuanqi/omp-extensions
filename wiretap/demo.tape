# Records the wiretap demo. Two-step on Windows (vhs's internal ffmpeg step
# fails silently there, and its frames rename breaks across volumes):
#
#   1) capture frames — TMP must be on the SAME drive as this directory:
#      mkdir .vhstmp
#      set TMP=D:\path\to\wiretap\.vhstmp && set TEMP=%TMP%
#      vhs < demo.tape
#   2) compose the GIF:
#      ffmpeg -y -r 50 -start_number 1 -i wiretap-frames.png/frame-text-%05d.png ^
#        -r 50 -start_number 1 -i wiretap-frames.png/frame-cursor-%05d.png ^
#        -filter_complex "[0][1]overlay[m];[m]split[a][b];[a]palettegen=max_colors=256[pal];[b][pal]paletteuse" ^
#        wiretap-demo.gif
#
# Runs a REAL omp session against your configured provider (ephemeral,
# --no-session). Tune "Sleep 25s" if your model is slower.
Output wiretap-frames.png
Set Width 1400
Set Height 900
Set FontSize 14
Set Theme "Catppuccin Mocha"

# Start omp with the extension loaded from this checkout
Type "omp --no-title --no-session -e ."
Enter
Sleep 5s

# Generate one real provider request
Type "Reply with exactly: ok"
Enter
Sleep 25s

# The capture list
Type "/wire"
Enter
Sleep 3s

# Full detail: endpoint, status, response headers, highlighted body
Type "/wire 1"
Enter
Sleep 5s
