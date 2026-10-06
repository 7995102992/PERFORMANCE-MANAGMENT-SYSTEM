package com.sentrifugo.db.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.math.BigDecimal;
import java.util.UUID;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@EqualsAndHashCode(callSuper = true)
public class PmsRatingScaleLevelDTO extends BaseDTO {

    private UUID id;

    private Integer ratingValue;

    private String label;

    private String definition;

    private BigDecimal minimumScore;

    private BigDecimal maximumScore;

    private String colourCode;

    private Integer displayOrder;

    private UUID ratingScaleId;
}
