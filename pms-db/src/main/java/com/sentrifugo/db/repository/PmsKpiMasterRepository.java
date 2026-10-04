package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsKpiMasterEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PmsKpiMasterRepository extends JpaRepository<PmsKpiMasterEntity, UUID> {

    /** Organisation-scoped lookup: the way to load a row without crossing tenants. */
    Optional<PmsKpiMasterEntity> findByIdAndOrganisationId(UUID id, UUID organisationId);

    List<PmsKpiMasterEntity> findByOrganisationIdAndIsActiveTrueOrderByCreatedDateAsc(UUID organisationId);

    List<PmsKpiMasterEntity> findByOrganisationIdAndIdIn(UUID organisationId, java.util.Collection<UUID> ids);

    boolean existsByKraIdAndIsActiveTrue(UUID kraId);

    boolean existsByKraIdAndNameIgnoreCaseAndIsActiveTrue(UUID kraId, String name);

    boolean existsByKraIdAndNameIgnoreCaseAndIsActiveTrueAndIdNot(UUID kraId, String name, UUID id);
}
