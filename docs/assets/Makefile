demo.gif: demo.cast
	agg --cols 120 --rows 40 --idle-time-limit 1 --last-frame-duration 4 demo.cast demo.gif

demo.mp4: demo.gif
	ffmpeg -y -i demo.gif -movflags faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" demo.mp4
