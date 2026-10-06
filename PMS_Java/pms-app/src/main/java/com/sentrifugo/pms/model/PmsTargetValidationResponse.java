package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.math.BigDecimal;
import java.util.List;

/** Screen 3.4: the checks behind "Validate". {@code valid} is true only when {@code errors} is empty. */
public record PmsTargetValidationResponse(
        @JsonProperty("valid") boolean valid,
        @JsonProperty("total_weightage") BigDecimal totalWeightage,
        @JsonProperty("errors") List<String> errors) {
}
