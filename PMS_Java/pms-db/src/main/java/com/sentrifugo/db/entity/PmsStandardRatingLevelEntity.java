package com.sentrifugo.db.entity;

import com.sentrifugo.db.enums.PmsMasterStatus;
import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.util.UUID;

/**
 * A reusable rating level kept in the master list (the "standards" a rating scale is built from).
 * Score ranges are not stored here: each scale sets its own.
 */
@Entity
@Table(
        name = "standard_rating_level",
        schema = "pms",
        indexes = {
                @Index(name = "idx_standard_rating_level_org", columnList = "organisation_id"),
                @Index(name = "idx_standard_rating_level_status", columnList = "status")
        }
)
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsStandardRatingLevelEntity extends BaseEntity<UUID> {

    @Column(name = "organisation_id", nullable = false)
    private String organisationId;

    @Column(name = "label", nullable = false, length = 100)
    private String label;

    @Column(name = "definition", length = 500)
    private String definition;

    /** Hex colour, e.g. #16A34A. */
    @Column(name = "colour_code", length = 7)
    private String colourCode;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 20)
    private PmsMasterStatus status;
}
