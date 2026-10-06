package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/** Add / edit a standard rating level in the master list. {@code colour_code} is {@code #RRGGBB}. */
public record PmsStandardRatingLevelRequest(
        @JsonProperty("label") @NotBlank @Size(max = 100) String label,
        @JsonProperty("definition") @Size(max = 500) String definition,
        @JsonProperty("colour_code") @Pattern(regexp = "^#[0-9A-Fa-f]{6}$") String colourCode) {
}
