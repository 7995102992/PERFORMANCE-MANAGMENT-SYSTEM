package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.NotBlank;

/** Employee decision on their own goals (acknowledge). */
public record PmsGoalDecisionRequest(
        @JsonProperty("financial_year") @NotBlank String financialYear,
        @JsonProperty("comment") String comment) {
}
