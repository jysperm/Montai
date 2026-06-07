ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
TIMELINE_DIR := $(ROOT)/tests/fcpxml/timelines

# A timeline's optional second extension declares its output intent:
#   name.json          → project default resolution
#   name.matrix.json   → exported once per MATRIX_RESOLUTIONS
#   name.<preset>.json → pinned to that single resolution
# The full stem (with token) is the timeline's load name; export-fcpxml strips
# the token for a clean output filename. Plain files use the project default.
MATRIX_RESOLUTIONS := 1080p 1080v 1080s
MARKED_FILES := $(wildcard $(TIMELINE_DIR)/*.*.json)
DEFAULT_TIMELINES := $(basename $(notdir $(filter-out $(MARKED_FILES),$(wildcard $(TIMELINE_DIR)/*.json))))

marked_stem = $(basename $(notdir $(1)))
marked_token = $(patsubst .%,%,$(suffix $(call marked_stem,$(1))))
marked_specs = $(if $(filter matrix,$(call marked_token,$(1))),\
	$(addprefix $(call marked_stem,$(1))@,$(MATRIX_RESOLUTIONS)),\
	$(call marked_stem,$(1))@$(call marked_token,$(1)))

TIMELINES := $(DEFAULT_TIMELINES) $(foreach f,$(MARKED_FILES),$(call marked_specs,$(f)))

.PHONY: fcpxml
fcpxml: fixtures
	cd $(ROOT) && npm exec -- tsx tests/fcpxml/export-fcpxml.ts $(TIMELINES)

.PHONY: preview
preview: fixtures
	cd $(ROOT) && npm exec -- tsx tests/fcpxml/preview-timelines.ts $(TIMELINES)

.PHONY: fixtures
fixtures:
	$(MAKE) -C $(ROOT)/tests/fixtures
