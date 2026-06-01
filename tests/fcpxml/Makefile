ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
TIMELINE_DIR := $(ROOT)/tests/fcpxml/timelines
DEFAULT_TIMELINES := $(basename $(notdir $(filter-out $(TIMELINE_DIR)/spatial-test.json,$(wildcard $(TIMELINE_DIR)/*.json))))
SPATIAL_RESOLUTIONS := 1080p 1080v 1080s
TIMELINES := $(DEFAULT_TIMELINES) $(addprefix spatial-test@,$(SPATIAL_RESOLUTIONS))

.PHONY: fcpxml
fcpxml: fixtures
	cd $(ROOT) && npm exec -- tsx tests/fcpxml/export-fcpxml.ts $(TIMELINES)

.PHONY: preview
preview: fixtures
	cd $(ROOT) && npm exec -- tsx tests/fcpxml/preview-timelines.ts $(TIMELINES)

.PHONY: fixtures
fixtures:
	$(MAKE) -C $(ROOT)/tests/fixtures
