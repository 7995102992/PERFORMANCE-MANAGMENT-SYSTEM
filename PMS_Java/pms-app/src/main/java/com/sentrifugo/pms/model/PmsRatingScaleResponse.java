package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/** A rating scale with its levels, highest rating first (screens 1.5 and 2.10). */
public record PmsRatingScaleResponse(
        @JsonProperty("id") UUID id,
        @JsonProperty("name") String name,
        @JsonProperty("description") String description,
        @JsonProperty("status") String status,
        @JsonProperty("is_default") boolean isDefault,
        @JsonProperty("show_definitions_to_employees") boolean showDefinitionsToEmployees,
        @JsonProperty("levels") List<Level> levels) {

    public record Level(
            @JsonProperty("rating_value") Integer ratingValue,
            @JsonProperty("label") String label,
            @JsonProperty("definition") String definition,
            @JsonProperty("minimum_score") BigDecimal minimumScore,
            @JsonProperty("maximum_score") BigDecimal maximumScore,
            @JsonProperty("colour_code") String colourCode,
            @JsonProperty("display_order") Integer displayOrder) {
    }
}
