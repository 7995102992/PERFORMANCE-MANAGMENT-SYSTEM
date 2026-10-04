package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.math.BigDecimal;
import java.util.List;

/** Create / save payload for a rating scale (screen 2.10 "Save Scale"). */
public record PmsRatingScaleRequest(
        @JsonProperty("name") @NotBlank @Size(max = 150) String name,
        @JsonProperty("description") String description,
        /** {@code active | inactive}; defaults to active. */
        @JsonProperty("status") String status,
        @JsonProperty("is_default") Boolean isDefault,
        @JsonProperty("show_definitions_to_employees") Boolean showDefinitionsToEmployees,
        @JsonProperty("levels") @NotEmpty List<@Valid Level> levels) {

    public record Level(
            @JsonProperty("rating_value") @NotNull @Min(1) Integer ratingValue,
            @JsonProperty("label") @NotBlank @Size(max = 100) String label,
            @JsonProperty("definition") String definition,
            @JsonProperty("minimum_score") @NotNull @DecimalMin("0.00") @DecimalMax("999.99") BigDecimal minimumScore,
            @JsonProperty("maximum_score") @NotNull @DecimalMin("0.00") @DecimalMax("999.99") BigDecimal maximumScore,
            @JsonProperty("colour_code") @Pattern(regexp = "^#[0-9a-fA-F]{6}$") String colourCode,
            @JsonProperty("display_order") Integer displayOrder) {
    }
}
