package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotNull;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/** Screen 2.4 (Competency Configuration): the ticked competencies and their weights, which must total 100. */
public record PmsGoalTemplateCompetencyRequest(
        @JsonProperty("competencies") @NotNull List<@Valid Item> competencies) {

    public record Item(
            @JsonProperty("competency_id") @NotNull UUID competencyId,
            @JsonProperty("weightage") @NotNull @DecimalMin(value = "0.00", inclusive = false)
            @DecimalMax("100.00") BigDecimal weightage) {
    }
}
