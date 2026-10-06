package com.sentrifugo.db.entity;

import com.sentrifugo.db.enums.PmsMasterStatus;
import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.util.UUID;

/** Screens 1.5 and 2.10 - an organisation's rating scale; its levels are {@link PmsRatingScaleLevelEntity}. */
@Entity
@Table(
        name = "rating_scale",
        schema = "pms",
        indexes = {
                @Index(name = "idx_rating_scale_org", columnList = "organisation_id"),
                @Index(name = "idx_rating_scale_status", columnList = "status"),
                @Index(name = "idx_rating_scale_default", columnList = "is_default")
        }
)
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsRatingScaleEntity extends BaseEntity<UUID> {

    @Column(name = "organisation_id", nullable = false)
    private String organisationId;

    @Column(name = "name", nullable = false, length = 150)
    private String name;

    @Column(name = "description", columnDefinition = "TEXT")
    private String description;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 20)
    private PmsMasterStatus status;

    @Column(name = "is_default", nullable = false)
    @Builder.Default
    private Boolean isDefault = false;

    @Column(name = "show_definitions_to_employees", nullable = false)
    @Builder.Default
    private Boolean showDefinitionsToEmployees = true;
}
