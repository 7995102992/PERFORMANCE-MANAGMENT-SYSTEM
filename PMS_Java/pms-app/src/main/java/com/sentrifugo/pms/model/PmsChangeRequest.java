package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import java.math.BigDecimal;
import java.util.UUID;

/** Employee asks for one target to change (screen 4.2). */
public record PmsChangeRequest(
        @JsonProperty("financial_year") @NotBlank String financialYear,
        @JsonProperty("kpi_id") @NotNull UUID kpiId,
        @JsonProperty("proposed_target") BigDecimal proposedTarget,
        @JsonProperty("reason") @NotBlank String reason) {
}
