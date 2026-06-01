ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
FIXTURES_DIR := $(ROOT)/tests/fixtures/output
FIXTURES_ENTRY := $(ROOT)/tests/fixtures/src/index.tsx
TEST_MEDIA_AUDIO := $(FIXTURES_DIR)/beep.wav
TEST_MEDIA_RENDER := npm exec -- remotion render $(FIXTURES_ENTRY)
TEST_MEDIA_RENDER_FLAGS := --codec h264 --pixel-format yuv420p --public-dir $(FIXTURES_DIR) --overwrite
TEST_MEDIA_FILES := \
	$(FIXTURES_DIR)/landscape.mp4 \
	$(FIXTURES_DIR)/portrait.mp4 \
	$(FIXTURES_DIR)/portrait-misoriented.mp4 \
	$(FIXTURES_DIR)/landscape-misoriented.mp4
TEST_MUSIC_FILES := \
	$(FIXTURES_DIR)/music-long.wav \
	$(FIXTURES_DIR)/music-short.wav
TEST_VOICEOVER_FILES := \
	$(FIXTURES_DIR)/narration.wav

.PHONY: all
all: $(TEST_MEDIA_FILES) $(TEST_MUSIC_FILES) $(TEST_VOICEOVER_FILES)

$(FIXTURES_DIR):
	mkdir -p $(FIXTURES_DIR)

$(TEST_MEDIA_AUDIO): $(ROOT)/tests/fixtures/generate-beep.ts | $(FIXTURES_DIR)
	cd $(ROOT) && npm exec -- tsx tests/fixtures/generate-beep.ts

$(FIXTURES_DIR)/music-long.wav $(FIXTURES_DIR)/music-short.wav: $(ROOT)/tests/fixtures/generate-music.ts $(ROOT)/tests/fixtures/index.ts | $(FIXTURES_DIR)
	cd $(ROOT) && npm exec -- tsx tests/fixtures/generate-music.ts

$(FIXTURES_DIR)/narration.wav: | $(FIXTURES_DIR)
	say -o $@ --data-format=LEI16@48000 "We begin on a quiet street just after sunrise. The camera follows the path toward the station, where the first shops are opening and the city is starting to move. A cyclist passes through the frame, the light changes, and the scene settles into the rhythm of an ordinary morning. Near the corner, a vendor lifts the shutter on a small cafe while steam gathers against the window. The shot holds for a moment, then moves past the crosswalk toward a row of apartment balconies. Someone waters plants above the sidewalk, and the sound of traffic grows softer as the route turns into a side street. This narration is used as a steady voiceover fixture for timing, trimming, fades, and export checks."
	duration_seconds=$$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $@ | awk '{ printf "%d", $$1 + 0.5 }'); \
	sed -i '' -E "s@(/\* narration-duration:start \*/)[0-9]+(/\* narration-duration:end \*/)@\1$$duration_seconds\2@g" $(ROOT)/tests/fixtures/index.ts

$(FIXTURES_DIR)/landscape.mp4: $(FIXTURES_ENTRY) $(TEST_MEDIA_AUDIO) | $(FIXTURES_DIR)
	cd $(ROOT) && $(TEST_MEDIA_RENDER) landscape $@ $(TEST_MEDIA_RENDER_FLAGS)

$(FIXTURES_DIR)/portrait.mp4: $(FIXTURES_ENTRY) $(TEST_MEDIA_AUDIO) | $(FIXTURES_DIR)
	cd $(ROOT) && $(TEST_MEDIA_RENDER) portrait $@ $(TEST_MEDIA_RENDER_FLAGS)

$(FIXTURES_DIR)/portrait-misoriented.mp4: $(FIXTURES_ENTRY) $(TEST_MEDIA_AUDIO) | $(FIXTURES_DIR)
	cd $(ROOT) && $(TEST_MEDIA_RENDER) portrait-misoriented $@ $(TEST_MEDIA_RENDER_FLAGS)

$(FIXTURES_DIR)/landscape-misoriented.mp4: $(FIXTURES_ENTRY) $(TEST_MEDIA_AUDIO) | $(FIXTURES_DIR)
	cd $(ROOT) && $(TEST_MEDIA_RENDER) landscape-misoriented $@ $(TEST_MEDIA_RENDER_FLAGS)
