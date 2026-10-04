package com.sentrifugo.db.entity;

import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.util.UUID;

/** Screen 1.4 - a plant a cycle applies to. The plant master lives in the existing Sentrifugo system; only its id is stored. */
@Entity
@Table(
        name = "pms_cycle_plant",
        schema = "pms",
        uniqueConstraints = @UniqueConstraint(name = "uk_pms_cycle_plant_cycle_plant", columnNames = {"cycle_id", "plant_id"}),
        indexes = {
                @Index(name = "idx_pms_cycle_plant_cycle", columnList = "cycle_id"),
                @Index(name = "idx_pms_cycle_plant_plant", columnList = "plant_id")
        }
)
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsCyclePlantEntity extends BaseEntity<UUID> {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "cycle_id", nullable = false)
    private PmsCycleEntity cycle;

    @Column(name = "plant_id", nullable = false)
    private UUID plantId;
}
