package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/** Save draft / validate body. A null {@code target} is allowed while drafting. */
public record PmsTargetsRequest(
        @JsonProperty("employee_user_id") @NotBlank String employeeUserId,
        @JsonProperty("financial_year") @NotBlank @Size(max = 20) String financialYear,
        @JsonProperty("targets") @NotNull @Valid List<Target> targets) {

    public record Target(
            @JsonProperty("kpi_id") @NotNull UUID kpiId,
            @JsonProperty("weight") @NotNull BigDecimal weight,
            @JsonProperty("target") BigDecimal target) {
    }
}
