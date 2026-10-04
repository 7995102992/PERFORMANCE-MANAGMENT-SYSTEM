package com.sentrifugo.db.entity;

import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.math.BigDecimal;
import java.util.UUID;

/** Screen 2.10 - one rating value on a scale, e.g. 5 / Outstanding / 4.50-5.00 / green. */
@Entity
@Table(
        name = "rating_scale_level",
        schema = "pms",
        uniqueConstraints = @UniqueConstraint(name = "uk_rating_scale_level_scale_value", columnNames = {"rating_scale_id", "rating_value"}),
        indexes = @Index(name = "idx_rating_scale_level_scale", columnList = "rating_scale_id")
)
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsRatingScaleLevelEntity extends BaseEntity<UUID> {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "rating_scale_id", nullable = false)
    private PmsRatingScaleEntity ratingScale;

    @Column(name = "rating_value", nullable = false)
    private Integer ratingValue;

    @Column(name = "label", nullable = false, length = 100)
    private String label;

    @Column(name = "definition", columnDefinition = "TEXT")
    private String definition;

    @Column(name = "minimum_score", precision = 5, scale = 2)
    private BigDecimal minimumScore;

    @Column(name = "maximum_score", precision = 5, scale = 2)
    private BigDecimal maximumScore;

    @Column(name = "colour_code", length = 20)
    private String colourCode;

    @Column(name = "display_order")
    private Integer displayOrder;
}
