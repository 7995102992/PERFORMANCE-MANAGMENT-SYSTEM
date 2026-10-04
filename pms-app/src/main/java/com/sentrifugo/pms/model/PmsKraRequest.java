package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** Add / edit a KRA (screens 2.5, 2.6). {@code status} is {@code active | inactive}, default active. */
public record PmsKraRequest(
        @JsonProperty("name") @NotBlank @Size(max = 200) String name,
        @JsonProperty("status") String status) {
}
