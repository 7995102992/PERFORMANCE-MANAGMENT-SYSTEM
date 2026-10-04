package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.time.LocalDate;
import java.util.UUID;

/**
 * Create / update payload for a cycle. {@code organisation_id}, {@code cycle_code}, status and the audit columns
 * are never accepted from the client.
 *
 * <p>Only the parts the current persistence model can store are accepted: {@code basic}, {@code finalize} and the
 * wizard step markers. {@code stages} and {@code applicability} have no tables yet and are not part of this request.
 */
public record PmsCycleRequest(
        @JsonProperty("basic") @NotNull @Valid Basic basic,
        @JsonProperty("finalize") @Valid Finalize finalizeSettings,
        @JsonProperty("current_step") @Min(1) @Max(4) Integer currentStep,
        @JsonProperty("completed_step") @Min(0) @Max(4) Integer completedStep) {

    public record Basic(
            @JsonProperty("name") @NotBlank @Size(max = 200) String name,
            @JsonProperty("description") @Size(max = 2000) String description,
            @JsonProperty("type") @NotBlank String type,
            @JsonProperty("period_start") @NotNull LocalDate periodStart,
            @JsonProperty("period_end") @NotNull LocalDate periodEnd) {
    }

    public record Finalize(
            @JsonProperty("rating_scale_id") UUID ratingScaleId,
            @JsonProperty("notify_managers") Boolean notifyManagers,
            @JsonProperty("notify_employees") Boolean notifyEmployees,
            @JsonProperty("notify_hod") Boolean notifyHod,
            @JsonProperty("notify_hr") Boolean notifyHr) {
    }
}
